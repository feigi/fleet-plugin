// pull-attribution.mjs: the one booking the cost guard (pr-cost.mjs) and the
// router's fit (ticket-router.mjs) both read. Each case is run through the
// attribution itself and through both consumers, so a figure the two scripts
// print differently fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatTsv, parseTsv as parseMemberTsv } from "../plugin/scripts/member-outcomes.mjs";
import { formatRow, parseTierOutcomes } from "../plugin/scripts/tier-outcomes.mjs";
import { AttributionError, FEATURE_COLUMNS, TRIP_POINTS, admissibleRow, attribute, bootUnit, bootstrapDiffCI, parseFeatures, tally, underFloor } from "../plugin/scripts/pull-attribution.mjs";
import { WINDOW_START, computeReport, guardFile } from "../plugin/scripts/pr-cost.mjs";
import { fitTable, readGuard } from "../plugin/scripts/ticket-router.mjs";

const DAY = WINDOW_START;
const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";
const SESSION2 = "2026-10-05T10-00-00-000Z_01a00000-0000-7000-8000-000000000001";

const world = () => ({ members: [], tiers: [], features: [], prs: [] });
const member = (o) => ({
  session: SESSION, run_date: DAY, role: "implementer", member: o.agent, model: "claude-opus-5", effort: "high",
  ticket: "", pr: "", tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, harness: "omp", subagentType: "",
  tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: "", cost: 1, ending: "", dispatchModel: o.model ?? "claude-opus-5", workS: 60, ...o,
});
// An implementer row of `ticket` dispatched as `cell`'s definition at its level.
const impl = (ticket, cell, o = {}) => member({
  agent: `impl-${ticket}`, ticket: String(ticket), effort: cell.split("-")[1], subagentType: `fleet-implementer-${cell}`, ...o,
});
const pull = (ticket, cell, o = {}) => ({
  run_date: DAY, session: SESSION, agent: `impl-${ticket}`, ticket: String(ticket), policy_cell: "slow-high", chosen_cell: cell,
  exploration_draw: "1/3", sizing_src: "rule", sizing_pre: "", router_usd: "", brief_chars: "100", criteria: "1",
  comments: "0", age_days: "0", paths: "0", test_paths: "0", xrefs: "0", kind: "enhancement", ...o,
});
const ruling = (ticket, pr, o = {}) => ({
  run_date: DAY, pr: String(pr), ticket: String(ticket), class: "", tier: "", closed_own_ticket: "yes", minted_false_claim: "no",
  note: "n", sizing: "", profile: "", loc: "", files: "", ...o,
});
const merged = (w, pr, state = "MERGED") => w.prs.push({ number: pr, state, mergedAt: null });

// The world as both scripts read it: through the TSV parsers.
const parsed = (w) => ({
  members: parseMemberTsv(formatTsv(w.members)),
  tiers: parseTierOutcomes(w.tiers.map(formatRow).join("\n")),
  features: parseFeatures([FEATURE_COLUMNS.join("\t"), ...w.features.map((f) => FEATURE_COLUMNS.map((c) => f[c] ?? "").join("\t"))].join("\n")),
});
const prior = {
  window_start: null, fitted_commit: null, n_rows: 0, stage: 1, cells: ["slow-high", "task-high", "smol-high"], burn_in: true,
  rows: { "*": "slow-high" }, classifier: { b: null, tau: null }, estimates: {}, guard: { tripped: [], n: {} },
};
// One world's per-cell figures, in the guard's report and in the fit's table.
function figures(w) {
  const p = parsed(w);
  const guard = Object.fromEntries(computeReport({ ...p, prs: w.prs }).cells.map((c) => [c.cell, {
    n: c.n_pulls, merged: c.n_merged, failed: c.n_failed, excluded: c.excluded, left_out: c.left_out, unpriced: c.unpriced, untimed: c.untimed, usd: c.mean_usd,
  }]));
  const est = fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: {}, window_start: DAY } }).estimates["*"] ?? {};
  const fit = Object.fromEntries(Object.entries(est).map(([c, e]) => [c, {
    n: e.n, merged: e.merged, failed: e.failed, excluded: e.excluded, left_out: e.left_out, unpriced: e.unpriced, untimed: e.untimed, usd: e.usd_per_merged,
  }]));
  return { guard, fit };
}
const units = (w, prs = w.prs) => attribute({ ...parsed(w), prs, windowStart: DAY });
const cell = (o) => ({ n: 0, merged: 0, failed: 0, excluded: 0, left_out: 0, unpriced: 0, untimed: 0, usd: null, ...o });

test("rescue: three budget-exhausted implementers at the cell and a fourth elsewhere that merges count once, for the drawn cell, with every implementer's and the PR's spend", () => {
  const w = world();
  w.features.push(pull(10, "smol-high"));
  w.members.push(
    impl(10, "smol-high", { ending: "budget", cost: 1 }),
    impl(10, "smol-high", { agent: "impl-10-b", ending: "budget", cost: 2 }),
    impl(10, "smol-high", { agent: "impl-10-c", ending: "budget", cost: 4 }),
    impl(10, "slow-high", { agent: "impl-10-d", ending: "pr", pr: "110", cost: 8 }),
    member({ agent: "review-pr-110", role: "reviewer", pr: "110", cost: 16 }),
    member({ agent: "fix-pr-110", role: "fix-applier", pr: "110", cost: 32 }),
    member({ agent: "finisher-pr-110", role: "finisher", pr: "110", cost: 64 }),
  );
  w.tiers.push(ruling(10, 110));
  merged(w, 110);
  const [u] = units(w);
  assert.equal(u.status, "counted");
  assert.equal(u.cell, "smol-high");
  assert.equal(u.merged, true);
  assert.equal(u.spend, 127, "all four implementers plus the review, fix and finisher rows");
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "smol-high": cell({ n: 1, merged: 1, usd: 127 }) });
  assert.deepEqual(fit, guard, "fit and guard agree");
});

test("veto: a Pull whose only implementer ran at another cell is in neither cell's figures, and its drawn cell's excluded count rises", () => {
  const w = world();
  w.features.push(pull(11, "smol-high"));
  w.members.push(impl(11, "slow-high", { ending: "pr", pr: "111" }));
  w.tiers.push(ruling(11, 111));
  merged(w, 111);
  assert.equal(units(w)[0].status, "excluded");
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "smol-high": cell({ excluded: 1 }) });
  assert.deepEqual(fit, guard);
});

test("wrong-cell dispatch: a first implementer elsewhere that aborted and a replacement at the drawn cell that merged count for the drawn cell", () => {
  const w = world();
  w.features.push(pull(12, "smol-high"));
  w.members.push(
    impl(12, "slow-high", { ending: "abort", cost: 1 }),
    impl(12, "smol-high", { agent: "impl-12-b", ending: "pr", pr: "112", cost: 3 }),
  );
  w.tiers.push(ruling(12, 112));
  merged(w, 112);
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "smol-high": cell({ n: 1, merged: 1, usd: 4 }) });
  assert.deepEqual(fit, guard);
});

test("never merged with only the ticket's or neither's endings is left out; a hollow ending keeps it counted, with spend and no merge", () => {
  const w = world();
  w.features.push(pull(13, "task-high"), pull(14, "task-high"), pull(15, "task-high"));
  w.members.push(
    impl(13, "task-high", { ending: "bail:undecided" }),
    impl(14, "task-high", { ending: "abort" }),
    impl(14, "task-high", { agent: "impl-14-b", ending: "bail:covered" }),
    impl(15, "task-high", { ending: "hollow", cost: 5 }),
  );
  assert.deepEqual(units(w).map((u) => u.status), ["left-out", "left-out", "counted"]);
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "task-high": cell({ n: 1, left_out: 2 }) }, "the hollow Pull's $5 is spend over no merge");
  assert.deepEqual(fit, guard);
});

test("never merged with only a blocked implementer is left out in both figures; a blocked and a hollow implementer keep it counted", () => {
  const w = world();
  w.features.push(pull(19, "task-high"), pull(20, "task-high"));
  w.members.push(
    impl(19, "task-high", { ending: "blocked", cost: 7 }),
    impl(20, "task-high", { ending: "blocked", cost: 2 }),
    impl(20, "task-high", { agent: "impl-20-b", ending: "hollow", cost: 3 }),
  );
  assert.deepEqual(units(w).map((u) => u.status), ["left-out", "counted"]);
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "task-high": cell({ n: 1, left_out: 1 }) }, "the blocked Pull's $7 is booked to neither figure");
  assert.deepEqual(fit, guard);
});

test("a refuted `fixed` bail is one false claim in the fail rate; an unrefuted one is one claim, not failed, and keeps its never-merged Pull counted", () => {
  const w = world();
  w.features.push(pull(16, "slow-high"), pull(17, "slow-high"), pull(18, "slow-high"));
  w.members.push(
    impl(16, "slow-high", { ending: "bail:fixed-refuted" }),
    impl(17, "slow-high", { ending: "bail:fixed" }),
    impl(18, "slow-high", { ending: "hollow" }),
    impl(18, "slow-high", { agent: "impl-18-b", ending: "bail:fixed" }),
  );
  const [refuted, fixed, afterHollow] = units(w);
  assert.deepEqual([refuted.status, refuted.claims, refuted.falseClaims], ["counted", 1, 1]);
  assert.deepEqual([fixed.status, fixed.claims, fixed.falseClaims], ["counted", 1, 0], "a lone `fixed` bail is a claim, so its Pull is never left out");
  assert.deepEqual([afterHollow.status, afterHollow.claims, afterHollow.falseClaims], ["counted", 1, 0]);
  const p = parsed(w);
  const rep = computeReport({ ...p, prs: w.prs });
  assert.deepEqual(rep.cells.map((c) => [c.n_pulls, c.n_claims, c.n_failed, c.fail_rate]), [[3, 3, 1, 0.3333]]);
  const est = fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: {}, window_start: DAY } }).estimates["*"]["slow-high"];
  assert.deepEqual([est.n, est.claims, est.failed, est.fail_rate], [3, 3, 1, 0.3333]);
});

test("a merged PR ruled minted_false_claim=yes is failed; one closed unmerged is spend and never a failure", () => {
  const w = world();
  w.features.push(pull(19, "slow-high"), pull(20, "slow-high"));
  w.members.push(impl(19, "slow-high", { ending: "pr", pr: "119", cost: 2 }), impl(20, "slow-high", { ending: "pr", pr: "120", cost: 4 }));
  w.tiers.push(ruling(19, 119, { minted_false_claim: "yes" }), ruling(20, 120, { minted_false_claim: "yes" }));
  merged(w, 119);
  merged(w, 120, "CLOSED");
  const { guard } = figures(w);
  assert.deepEqual(guard, { "slow-high": cell({ n: 2, merged: 1, failed: 1, usd: 6 }) }, "the closed PR's $4 is spend, and its ruling no failure");
  const [, closed] = units(w);
  assert.deepEqual([closed.status, closed.merged, closed.claims, closed.falseClaims], ["counted", false, 0, 0]);
});

test("the fit, which reads no PR state, counts a ruled Pull as merged; the guard holds an open PR pending until it settles", () => {
  const w = world();
  w.features.push(pull(21, "slow-high"), pull(22, "slow-high"));
  w.members.push(impl(21, "slow-high", { ending: "pr", pr: "121" }), impl(22, "slow-high", { ending: "pr", pr: "122" }));
  w.tiers.push(ruling(21, 121));
  merged(w, 121, "OPEN");
  merged(w, 122, "OPEN");
  const p = parsed(w);
  const rep = computeReport({ ...p, prs: w.prs });
  assert.deepEqual(rep.pending, ["121", "122"], "a ruled open PR and an unruled Pull's open PR are both pending");
  assert.deepEqual(rep.cells.map((c) => [c.cell, c.n_pulls, c.n_merged]), [["slow-high", 0, 0]], "neither is in the cell's figures");
  assert.deepEqual(figures(w).fit, { "slow-high": cell({ n: 2, merged: 1, usd: 2 }) }, "the fit counts the ruled one merged and the other as spend");
});

test("one ticket Pulled in two sessions is two units, each with its own session's implementers", () => {
  const w = world();
  w.features.push(pull(23, "slow-high"), pull(23, "task-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(
    impl(23, "slow-high", { ending: "hollow", cost: 2 }),
    impl(23, "task-high", { session: SESSION2, run_date: "2026-10-05", ending: "pr", pr: "123", cost: 3 }),
  );
  w.tiers.push(ruling(23, 123, { run_date: "2026-10-05" }));
  merged(w, 123);
  const [first, second] = units(w);
  assert.deepEqual(first.rows.map((r) => r.session), [SESSION]);
  assert.deepEqual(second.rows.map((r) => r.session), [SESSION2]);
  assert.deepEqual([first.merged, second.merged], [false, true], "the ruling dated after both rules only the Pull that carries its PR");
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "slow-high": cell({ n: 1 }), "task-high": cell({ n: 1, merged: 1, usd: 3 }) });
  assert.deepEqual(fit, guard);
});

test("a claim resumed in a later session joins the ticket's latest earlier Pull, never a later one", () => {
  const w = world();
  const LATER = "2026-10-07T10-00-00-000Z_01a00000-0000-7000-8000-000000000002";
  w.features.push(pull(24, "slow-high"), pull(24, "task-high", { session: LATER, run_date: "2026-10-07" }));
  w.members.push(
    impl(24, "slow-high", { ending: "hollow", cost: 1 }),
    impl(24, "slow-high", { agent: "impl-24-b", session: SESSION2, run_date: "2026-10-08", ending: "hollow", cost: 2 }),
    impl(24, "task-high", { session: LATER, run_date: "2026-10-07", ending: "hollow", cost: 4 }),
  );
  assert.deepEqual(units(w).map((u) => u.spend), [3, 4], "the SESSION2 row books to the SESSION Pull, the only one started before it");
});

test("a claim resumed after two earlier Pulls joins the later of them", () => {
  const w = world();
  const LATER = "2026-10-07T10-00-00-000Z_01a00000-0000-7000-8000-000000000002";
  w.features.push(pull(41, "slow-high"), pull(41, "task-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(
    impl(41, "slow-high", { ending: "hollow", cost: 1 }),
    impl(41, "task-high", { session: SESSION2, run_date: "2026-10-05", ending: "hollow", cost: 2 }),
    impl(41, "task-high", { agent: "impl-41-b", session: LATER, run_date: "2026-10-07", ending: "hollow", cost: 4 }),
  );
  assert.deepEqual(units(w).map((u) => u.spend), [1, 6], "the LATER row books to the SESSION2 Pull, the latest started before it");
});

test("an implementer row matching no Pull's agent in its own session joins that session's last Pull of its ticket", () => {
  const w = world();
  w.features.push(pull(42, "slow-high"), pull(42, "task-high", { agent: "impl-42-r" }));
  w.members.push(
    impl(42, "slow-high", { ending: "hollow", cost: 1 }),
    impl(42, "task-high", { agent: "impl-42-r", ending: "hollow", cost: 2 }),
    impl(42, "task-high", { agent: "impl-42-b", ending: "hollow", cost: 4 }),
  );
  assert.deepEqual(units(w).map((u) => u.spend), [1, 6]);
});

test("with session ids that carry no start time, a claim resumed on its Pull's own date joins that Pull", () => {
  const w = world();
  w.features.push(pull(46, "slow-high", { session: "sess-a" }));
  w.members.push(
    impl(46, "slow-high", { session: "sess-a", ending: "hollow", cost: 1 }),
    impl(46, "slow-high", { agent: "impl-46-b", session: "sess-b", ending: "hollow", cost: 2 }),
  );
  assert.deepEqual(units(w).map((u) => u.spend), [3], "a same-date row is no earlier than the Pull, so it books to it");
});

test("a Ruling no candidate Pull carries goes to the last of them in features file order, unpriced; the others stay unruled", () => {
  const w = world();
  w.features.push(pull(43, "slow-high"), pull(43, "task-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(
    impl(43, "slow-high", { ending: "hollow" }),
    impl(43, "task-high", { session: SESSION2, run_date: "2026-10-05", ending: "hollow" }),
  );
  w.tiers.push(ruling(43, 143, { run_date: "2026-10-05" }));
  merged(w, 143);
  const [first, second] = units(w);
  assert.deepEqual([first.status, first.merged, first.pr], ["counted", false, null]);
  assert.deepEqual([second.status, second.merged, second.pr], ["unpriced", true, "143"]);
});

test("the guard holds a ruled Pull pending when its PR is missing from the PR states", () => {
  const w = world();
  w.features.push(pull(44, "slow-high"));
  w.members.push(impl(44, "slow-high", { ending: "pr", pr: "144" }));
  w.tiers.push(ruling(44, 144));
  const [u] = units(w, []);
  assert.deepEqual([u.status, u.merged, u.pendingPr], ["pending", false, "144"]);
});

test("a merged Pull whose every implementer ending is neither's is counted, never left out", () => {
  const w = world();
  w.features.push(pull(45, "slow-high"));
  w.members.push(impl(45, "slow-high", { ending: "crash", pr: "145", cost: 3 }));
  w.tiers.push(ruling(45, 145));
  merged(w, 145);
  const [u] = units(w);
  assert.deepEqual([u.status, u.merged, u.claims], ["counted", true, 1]);
  assert.deepEqual(figures(w).guard, { "slow-high": cell({ n: 1, merged: 1, usd: 3 }) });
});

test("a fix-applier's nested member with no pr is in its Pull's spend in both scripts", () => {
  const w = world();
  w.features.push(pull(25, "slow-high"));
  w.members.push(
    impl(25, "slow-high", { ending: "pr", pr: "125", cost: 1 }),
    member({ agent: "fix-pr-125", role: "fix-applier", pr: "125", cost: 2 }),
    member({ agent: "fix-pr-125/fix-pr-125.RefuteU1", member: "fix-pr-125/fix-pr-125.RefuteU1", role: "specialist", cost: 4 }),
  );
  w.tiers.push(ruling(25, 125));
  merged(w, 125);
  const { guard, fit } = figures(w);
  assert.equal(guard["slow-high"].usd, 7);
  assert.equal(fit["slow-high"].usd, 7);
});

test("a booked row with a blank cost makes its Pull unpriced: out of n, merged, failed and $, and counted per cell, in both scripts", () => {
  const w = world();
  w.features.push(pull(26, "slow-high"), pull(27, "slow-high"));
  w.members.push(
    impl(26, "slow-high", { ending: "pr", pr: "126", cost: 2 }),
    member({ agent: "review-pr-126", role: "reviewer", pr: "126", cost: "" }),
    impl(27, "slow-high", { ending: "pr", pr: "127", cost: 3 }),
  );
  w.tiers.push(ruling(26, 126, { minted_false_claim: "yes" }), ruling(27, 127));
  merged(w, 126);
  merged(w, 127);
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "slow-high": cell({ n: 1, merged: 1, unpriced: 1, usd: 3 }) });
  assert.deepEqual(fit, guard);
});

test("a ruled, merged Pull whose PR none of its implementer rows carries is unpriced", () => {
  const w = world();
  w.features.push(pull(28, "slow-high"));
  w.members.push(impl(28, "slow-high", { ending: "hollow" }));
  w.tiers.push(ruling(28, 128));
  merged(w, 128);
  const [u] = units(w);
  assert.deepEqual([u.status, u.merged, u.pr], ["unpriced", true, "128"]);
  assert.deepEqual(figures(w).guard, { "slow-high": cell({ unpriced: 1 }) });
});

test("a cost that is neither blank nor a number is refused by both scripts, naming the row", () => {
  const w = world();
  w.features.push(pull(29, "slow-high"));
  w.members.push(impl(29, "slow-high", { cost: "1.2.3" }));
  const p = parsed(w);
  const named = (e) => e instanceof AttributionError && /session 2026-10-03T10-00-00-000Z_\S+ agent impl-29: cost '1\.2\.3' is not a number/.test(e.message);
  assert.throws(() => computeReport({ ...p, prs: [] }), named);
  assert.throws(() => fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: {}, window_start: DAY } }), named);
});

test("a whitespace-only cost is refused by both scripts, never read as $0", () => {
  const w = world();
  w.features.push(pull(47, "slow-high"));
  w.members.push(impl(47, "slow-high", { cost: "  " }));
  const p = parsed(w);
  const named = (e) => e instanceof AttributionError && /agent impl-47: cost ' {2}' is not a number/.test(e.message);
  assert.throws(() => computeReport({ ...p, prs: [] }), named);
  assert.throws(() => fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: {}, window_start: DAY } }), named);
});

// ---------------------------------------------------------------------------
// Work time: the summed work_s of a Pull's booked members that name no parent
// ---------------------------------------------------------------------------

// The fit's `*` row for `cell`, fitted as `figures` fits it.
const fitted = (w, c) => {
  const p = parsed(w);
  return fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: {}, window_start: DAY } }).estimates["*"][c];
};

test("work time sums the implementer, review runner, both fix rounds and finisher; the review runner's nested members add nothing, timed or blank", () => {
  const w = world();
  w.features.push(pull(50, "slow-high"));
  w.members.push(
    impl(50, "slow-high", { ending: "pr", pr: "150", workS: 3000 }),
    member({ agent: "review-pr-150", role: "reviewer", pr: "150", workS: 1200 }),
    member({ agent: "review-pr-150/review-pr-150.Spec1", member: "review-pr-150/review-pr-150.Spec1", role: "specialist", workS: 900 }),
    member({ agent: "review-pr-150/review-pr-150.Spec2", member: "review-pr-150/review-pr-150.Spec2", role: "specialist", workS: "" }),
    member({ agent: "fix-pr-150", role: "fix-applier", pr: "150", workS: 600 }),
    member({ agent: "fix-pr-150-b", role: "fix-applier", pr: "150", workS: 600 }),
    member({ agent: "finisher-pr-150", role: "finisher", pr: "150", workS: 300 }),
  );
  w.tiers.push(ruling(50, 150));
  merged(w, 150);
  const [u] = units(w);
  assert.deepEqual([u.status, u.workS, u.rows.length], ["counted", 5700, 7], "every row is booked; only the top-level ones are timed");
  assert.equal(fitted(w, "slow-high").minutes_per_merged, 95);
});

test("a rescued Pull's work time includes the rescue implementer's, at whatever cell it ran", () => {
  const w = world();
  w.features.push(pull(51, "smol-high"));
  w.members.push(
    impl(51, "smol-high", { ending: "budget", workS: 1000 }),
    impl(51, "slow-high", { agent: "impl-51-b", ending: "pr", pr: "151", workS: 2000 }),
  );
  w.tiers.push(ruling(51, 151));
  merged(w, 151);
  const [u] = units(w);
  assert.deepEqual([u.cell, u.status, u.workS], ["smol-high", "counted", 3000]);
  assert.equal(fitted(w, "smol-high").minutes_per_merged, 50);
});

test("a cell's minutes per merged PR is every counted Pull's work time, merged or not, over its merged PRs; null with none merged", () => {
  const w = world();
  w.features.push(pull(52, "task-high"), pull(53, "task-high"), pull(54, "task-high"), pull(55, "smol-high"));
  w.members.push(
    impl(52, "task-high", { ending: "pr", pr: "152", workS: 3600 }),
    impl(53, "task-high", { ending: "pr", pr: "153", workS: 5400 }),
    impl(54, "task-high", { ending: "hollow", workS: 1800 }),
    impl(55, "smol-high", { ending: "hollow", workS: 1800 }),
  );
  w.tiers.push(ruling(52, 152), ruling(53, 153));
  merged(w, 152);
  merged(w, 153);
  const task = fitted(w, "task-high");
  assert.deepEqual([task.n, task.merged, task.minutes_per_merged], [3, 2, 90], "(60 + 90 + 30) minutes over 2 merged PRs");
  const smol = fitted(w, "smol-high");
  assert.deepEqual([smol.n, smol.merged, smol.minutes_per_merged], [1, 0, null]);
});

test("a blank work_s on a top-level booked row makes its Pull untimed: out of n, merged, claims, $ and time, counted by both scripts; a blank cost as well reads unpriced", () => {
  const w = world();
  w.features.push(pull(56, "slow-high"), pull(57, "slow-high"));
  w.members.push(
    impl(56, "slow-high", { ending: "pr", pr: "156", cost: 2, workS: 600 }),
    member({ agent: "review-pr-156", role: "reviewer", pr: "156", cost: 4, workS: "" }),
    impl(57, "slow-high", { ending: "pr", pr: "157", cost: 3, workS: 1200 }),
  );
  w.tiers.push(ruling(56, 156, { minted_false_claim: "yes" }), ruling(57, 157));
  merged(w, 156);
  merged(w, 157);
  const [untimed] = units(w);
  assert.deepEqual([untimed.status, untimed.workS, untimed.spend], ["untimed", null, 6]);
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "slow-high": cell({ n: 1, merged: 1, untimed: 1, usd: 3 }) });
  assert.deepEqual(fit, guard);
  const est = fitted(w, "slow-high");
  assert.deepEqual([est.claims, est.fail_rate, est.minutes_per_merged], [1, 0, 20], "its claim and its time are out with it");

  w.members[1].cost = "";
  assert.equal(units(w)[0].status, "unpriced");
  const both = figures(w);
  assert.deepEqual(both.guard, { "slow-high": cell({ n: 1, merged: 1, unpriced: 1, usd: 3 }) });
  assert.deepEqual(both.fit, both.guard);
});

test("a blank work_s on a booked nested member alone leaves the Pull counted", () => {
  const w = world();
  w.features.push(pull(58, "slow-high"));
  w.members.push(
    impl(58, "slow-high", { ending: "pr", pr: "158", workS: 600 }),
    member({ agent: "fix-pr-158", role: "fix-applier", pr: "158", workS: 300 }),
    member({ agent: "fix-pr-158/fix-pr-158.RefuteU1", member: "fix-pr-158/fix-pr-158.RefuteU1", role: "specialist", workS: "" }),
  );
  w.tiers.push(ruling(58, 158));
  merged(w, 158);
  const [u] = units(w);
  assert.deepEqual([u.status, u.workS], ["counted", 900]);
  assert.deepEqual(figures(w).guard, { "slow-high": cell({ n: 1, merged: 1, usd: 3 }) });
});

test("a work_s that is neither blank nor a number is refused by both scripts, naming the row, on a nested row too, and a whitespace-only one is never read as 0", () => {
  for (const bad of ["1.2.3", "  "]) {
    const w = world();
    w.features.push(pull(59, "slow-high"));
    w.members.push(impl(59, "slow-high", { workS: bad }));
    const p = parsed(w);
    const named = (e) => e instanceof AttributionError && e.message.endsWith(`agent impl-59: work_s '${bad}' is not a number`);
    assert.throws(() => computeReport({ ...p, prs: [] }), named);
    assert.throws(() => fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: {}, window_start: DAY } }), named);
  }
  // A nested row's time is never summed, but its work_s is still read and refused.
  {
    const w = world();
    const nested = "fix-pr-161/fix-pr-161.RefuteU1";
    w.features.push(pull(61, "slow-high"));
    w.members.push(
      impl(61, "slow-high", { ending: "pr", pr: "161", workS: 600 }),
      member({ agent: "fix-pr-161", role: "fix-applier", pr: "161", workS: 300 }),
      member({ agent: nested, member: nested, role: "specialist", workS: "bad" }),
    );
    w.tiers.push(ruling(61, 161));
    merged(w, 161);
    const p = parsed(w);
    const named = (e) => e instanceof AttributionError && e.message.endsWith(`agent ${nested}: work_s 'bad' is not a number`);
    assert.throws(() => computeReport({ ...p, prs: [] }), named);
    assert.throws(() => fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: {}, window_start: DAY } }), named);
  }
  // A recorded zero is a number, not a blank.
  const w = world();
  w.features.push(pull(60, "slow-high"));
  w.members.push(impl(60, "slow-high", { workS: 0 }));
  assert.deepEqual(units(w).map((u) => [u.status, u.workS]), [["counted", 0]]);
});

test("router_usd and merge-bot, memory and advisor rows are no cell's $, while the A/B arms include router_usd", () => {
  const w = world();
  // Ticket 31 is arm B, and its sizing_pre is what lets the A/B report run.
  w.features.push(pull(30, "slow-high", { router_usd: "0.5" }), pull(31, "slow-high", { router_usd: "0.25", sizing_pre: "light" }));
  for (const t of [30, 31]) {
    w.members.push(
      impl(t, "slow-high", { ending: "pr", pr: String(t + 100), cost: 2 }),
      member({ agent: `merge-bot-${t}`, role: "merge-bot", pr: String(t + 100), cost: 100 }),
      member({ agent: `impl-${t}/impl-${t}.__advisor`, member: `impl-${t}/impl-${t}.__advisor`, role: "other", cost: 100 }),
      member({ agent: `review-pr-${t + 100}/review-pr-${t + 100}.memory`, member: `review-pr-${t + 100}/memory`, role: "memory", cost: 100 }),
    );
    w.tiers.push(ruling(t, t + 100));
    merged(w, t + 100);
  }
  const { guard, fit } = figures(w);
  assert.equal(guard["slow-high"].usd, 2);
  assert.equal(fit["slow-high"].usd, 2);
  const ab = computeReport({ ...parsed(w), prs: w.prs }).ab;
  assert.deepEqual([ab.A.mean_usd, ab.B.mean_usd], [2.5, 2.25]);
});

test("tally counts each status per cell, and only counted Pulls enter n, merged, claims, spend, work time and pulls", () => {
  const u = (cell, status, o = {}) => ({ cell, status, merged: false, claims: 0, falseClaims: 0, spend: 1, workS: 60, generation: null, ...o });
  const counted = u("task-high", "counted", { merged: true, claims: 1, spend: 3, workS: 600 });
  assert.deepEqual(tally([
    counted, u("slow-high", "excluded"), u("task-high", "left-out"),
    u("task-high", "unpriced", { spend: null }), u("task-high", "untimed", { workS: null }), u("task-high", "pending"),
  ]), [
    { cell: "slow-high", generation: null, n: 0, merged: 0, claims: 0, failed: 0, spend: 0, workS: 0, pulls: [], excluded: 1, left_out: 0, unpriced: 0, untimed: 0, pending: 0, older: [] },
    { cell: "task-high", generation: null, n: 1, merged: 1, claims: 1, failed: 0, spend: 3, workS: 600, pulls: [counted], excluded: 0, left_out: 1, unpriced: 1, untimed: 1, pending: 1, older: [] },
  ]);
});

test("admissibleRow: the cell's own definition at its level with a dispatch model on record, and nothing short of all three", () => {
  const row = { subagentType: "fleet-implementer-task-high", effort: "high", model: "m", dispatchModel: "m" };
  assert.equal(admissibleRow(row, "task-high"), true);
  assert.equal(admissibleRow({ ...row, effort: "medium" }, "task-high"), false);
  assert.equal(admissibleRow({ ...row, dispatchModel: "" }, "task-high"), false, "a blank dispatch model is unknown");
  assert.equal(admissibleRow({ ...row, model: "" }, "task-high"), true, "the last turn's model is not what admits a row");
  assert.equal(admissibleRow({ ...row, model: "ollama" }, "task-high"), true, "nor is a fallback's");
  assert.equal(admissibleRow({ ...row, subagentType: "fleet-implementer" }, "task-high"), false);
  assert.equal(admissibleRow(row, "smol-high"), false);
});

// ---------------------------------------------------------------------------
// Cell generations: one cell on one dispatch model
// ---------------------------------------------------------------------------

const SESSION3 = "2026-10-07T10-00-00-000Z_01a00000-0000-7000-8000-000000000002";
let nextTicket = 1000;
// `count` Pulls at `cell`, each its own ticket, dispatched on `model` in
// `session` at `usd` and `work` seconds apiece, their PRs in `state` (merged
// unless told); the first `fails` of them ruled a false claim.
function addPulls(w, { cell, model, count, session = SESSION, usd = 1, work = 60, fails = 0, state = "MERGED" }) {
  for (let i = 0; i < count; i++) {
    const t = nextTicket++;
    w.features.push(pull(t, cell, { session }));
    w.members.push(impl(t, cell, { session, model, dispatchModel: model, ending: "pr", pr: String(t + 10000), cost: usd, workS: work }));
    w.tiers.push(ruling(t, t + 10000, { minted_false_claim: i < fails ? "yes" : "no" }));
    merged(w, t + 10000, state);
  }
}
// The guard's report on `w`, and the fit over it, fed the guard file as the fit reads one.
function guarded(w) {
  const p = parsed(w);
  const report = computeReport({ ...p, prs: w.prs });
  const guard = readGuard(guardFile(report, "t"));
  const table = fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard });
  return { report, guard, table };
}
const baseline = (w, o = {}) => addPulls(w, { cell: "slow-high", model: "model-s", count: 20, usd: 10, ...o });

test("a cell's newest generation is judged alone: 25 merged on A then 22 on B reads B, with A's figures beside it, and A's trip never trips B", () => {
  const w = world();
  baseline(w);
  addPulls(w, { cell: "task-high", model: "model-t", count: 20, usd: 9 });
  // A alone trips on both legs ($20 against the baseline's $10, 40% false claims); B alone trips on neither.
  addPulls(w, { cell: "smol-high", model: "model-a", count: 25, usd: 20, work: 1800, fails: 10 });
  addPulls(w, { cell: "smol-high", model: "model-b", count: 22, usd: 2, work: 600, session: SESSION2 });
  const { report, guard, table } = guarded(w);

  const smol = report.cells.find((c) => c.cell === "smol-high");
  assert.deepEqual([smol.generation, smol.n_merged, smol.mean_usd, smol.fail_rate], ["model-b", 22, 2, 0]);
  assert.deepEqual(smol.older.map((o) => [o.generation, o.n_merged, o.mean_usd, o.fail_rate]), [["model-a", 25, 20, 0.4]]);
  assert.deepEqual(report.tripped, [], "the guard judges B alone, and B does not trip");
  assert.equal(report.verdict, "ok");
  assert.deepEqual(guardFile(report, "t").cells.find((c) => c.cell === "smol-high"), { cell: "smol-high", generation: "model-b", n: 22, mean_usd: 2, fail_rate: 0, untimed: 0 });
  assert.equal(guard.n["smol-high"], 22);

  const est = table.estimates["*"]["smol-high"];
  assert.deepEqual([est.generation, est.n, est.merged, est.usd_per_merged, est.minutes_per_merged, est.fail_rate], ["model-b", 22, 22, 2, 10, 0]);
  assert.deepEqual(Object.keys(est.older), ["model-a"]);
  const older = est.older["model-a"];
  assert.deepEqual([older.n, older.usd_per_merged, older.minutes_per_merged, older.fail_rate, older.untimed], [25, 20, 30, 0.4, 0]);
  assert.equal(table.estimates.light["smol-high"].older["model-a"].minutes_per_merged, 30, "a stratum row keeps each older generation's time too");
  // Pooled, smol-high's $ per merged PR is (25×20 + 22×2) / 47 ≈ $11.57, over the 0.75 × $10 adoption bar; B's $2 is under it.
  assert.equal(table.rows.cost["*"], "smol-high", "the fit adopts on B's figures alone");
});

test("with every work_s doubled, adoption, the quality floor and the guard's trips give the same verdicts", () => {
  const w = world();
  baseline(w, { work: 3000 });
  addPulls(w, { cell: "task-high", model: "model-t", count: 20, usd: 5, work: 6000 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 20, usd: 3, work: 600, fails: 10 });
  const twice = { ...w, members: w.members.map((m) => ({ ...m, workS: m.workS * 2 })) };
  // The guard's own verdicts, and the fit's with the guard's trips fed in and with none, so the fit's own floor judges smol-high.
  const verdicts = (x) => {
    const { report, table } = guarded(x);
    const p = parsed(x);
    const floor = fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: table.guard.n, window_start: DAY } });
    // The speed set's ranges are in minutes, so they double with the time; its verdicts do not.
    const speed = Object.fromEntries(Object.entries(table.reasons.speed).map(([s, r]) => [s, [r.cell, r.reason, Object.fromEntries(Object.entries(r.cells).map(([c, x]) => [c, x.verdict]))]]));
    return { tripped: report.tripped, verdict: report.verdict, retire: report.retire, rows: table.rows, reasons: table.reasons.cost, speed, floor: [floor.rows, floor.reasons.cost] };
  };
  const once = verdicts(w);
  assert.deepEqual([once.tripped, once.rows.cost["*"], once.floor[1]["*"].cells["smol-high"].verdict], [["smol-high"], "task-high", "under-floor"]);
  assert.deepEqual(verdicts(twice), once);
  assert.deepEqual([guarded(w), guarded(twice)].map(({ table }) => table.estimates["*"]["task-high"].minutes_per_merged), [100, 200], "the time itself was read");
});

test("the fit's range against slow-high is the guard's usd_diff_ci95: the same newest-generation Pulls, the same bootstrap", () => {
  const w = world();
  baseline(w);
  // task-high's older generation is dear; its newest one alternates $3 and $9 a PR.
  addPulls(w, { cell: "task-high", model: "model-a", count: 20, usd: 20 });
  for (let i = 0; i < 20; i++) addPulls(w, { cell: "task-high", model: "model-t", count: 1, usd: i % 2 ? 9 : 3, session: SESSION2 });
  const { report, table } = guarded(w);
  const ci = report.cells.find((c) => c.cell === "task-high").usd_diff_ci95;
  assert.equal(report.cells.find((c) => c.cell === "task-high").generation, "model-t");
  assert.ok(ci[1] < 0, `a range wholly below zero: ${ci}`);
  assert.deepEqual(table.reasons.cost["*"].cells["task-high"].range, ci);
  assert.equal(table.rows.cost["*"], "task-high");
});

test("an unmerged counted Pull is a bootstrap unit with its spend and no merged PR: 20 merged and 10 closed at $3 against $10 span -5.5, not a flat -7", () => {
  // Both ranges build their units with bootUnit; the guard reads PR state, so a closed PR is an unmerged counted Pull there.
  assert.deepEqual([bootUnit({ spend: 3, merged: false }), bootUnit({ spend: 3, merged: true })], [{ value: 3, merged: 0 }, { value: 3, merged: 1 }]);
  const w = world();
  baseline(w);
  addPulls(w, { cell: "task-high", model: "model-t", count: 20, usd: 3 });
  addPulls(w, { cell: "task-high", model: "model-t", count: 10, usd: 3, state: "CLOSED" });
  const th = computeReport({ ...parsed(w), prs: w.prs }).cells.find((c) => c.cell === "task-high");
  assert.deepEqual([th.n_pulls, th.n_merged, th.mean_usd], [30, 20, 4.5]);
  // Booked as merged, every resample of task-high would read $3 a PR, and the range would be [-7, -7].
  const ci = th.usd_diff_ci95;
  assert.ok(ci[0] < -5.5 && -5.5 < ci[1], `a range around $4.50 − $10: ${ci}`);
  assert.deepEqual(bootstrapDiffCI(Array(30).fill({ value: 3, merged: 1 }), Array(20).fill({ value: 10, merged: 1 })), [-7, -7]);
});

test("bootUnit takes a metric: `minutes` is a Pull's work time over 60, `usd` its spend and the default; bootstrapDiffCI reads the unit's value", () => {
  const u = { spend: 3, workS: 90, merged: true };
  assert.deepEqual([bootUnit(u), bootUnit(u, "usd"), bootUnit(u, "minutes")], [{ value: 3, merged: 1 }, { value: 3, merged: 1 }, { value: 1.5, merged: 1 }]);
  assert.deepEqual(bootstrapDiffCI(Array(20).fill(bootUnit({ ...u, workS: 60 }, "minutes")), Array(20).fill(bootUnit({ ...u, workS: 150 }, "minutes"))), [-1.5, -1.5]);
});

test("the floor and the bootstrap range are one rule each: both scripts import them from pull-attribution.mjs, and neither imports the other", () => {
  const src = (f) => readFileSync(new URL(`../plugin/scripts/${f}`, import.meta.url), "utf8");
  const guard = src("pr-cost.mjs"), fit = src("ticket-router.mjs");
  for (const s of [guard, fit]) {
    assert.match(s, /import \{[^}]*\bunderFloor\b[^}]*\} from "\.\/pull-attribution\.mjs"/);
    assert.match(s, /import \{[^}]*\bbootstrapDiffCI\b[^}]*\} from "\.\/pull-attribution\.mjs"/);
    assert.doesNotMatch(s, /function (?:bootstrapDiffCI|mulberry32|underFloor)\b|const TRIP_POINTS\b/);
  }
  assert.doesNotMatch(guard, /from "\.\/ticket-router\.mjs"/);
  assert.doesNotMatch(fit, /from "\.\/pr-cost\.mjs"/);
});

test("underFloor compares counts: 3 of 20 over the baseline is exactly 15 points, 2 of 20 against 3 of 30 is equal", () => {
  assert.equal(TRIP_POINTS, 15);
  assert.equal(underFloor({ claims: 20, failed: 7 }, { claims: 20, failed: 4 }), true);
  assert.equal(underFloor({ claims: 20, failed: 6 }, { claims: 20, failed: 4 }), false);
  assert.equal(underFloor({ claims: 20, failed: 8 }, { claims: 20, failed: 5 }), true, "40% against 25%");
  assert.equal(underFloor({ claims: 20, failed: 2 }, { claims: 30, failed: 3 }), false);
});

test("a model change re-enters burn-in: 3 merged on B after 30 on A is the guard's n, neither adopted nor tripped", () => {
  const w = world();
  baseline(w);
  addPulls(w, { cell: "task-high", model: "model-t", count: 20, usd: 9 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 30, usd: 2, fails: 30 });
  addPulls(w, { cell: "smol-high", model: "model-b", count: 3, usd: 2, session: SESSION2 });
  const { report, guard, table } = guarded(w);
  assert.equal(guardFile(report, "t").cells.find((c) => c.cell === "smol-high").n, 3);
  assert.equal(guard.n["smol-high"], 3);
  assert.deepEqual(report.tripped, [], "A's failures do not trip B, and B is short of MIN_N");
  assert.equal(table.rows.cost["*"], "slow-high", "B is short of MIN_N, so nothing adopts it");
  assert.equal(table.burn_in, true);
  assert.equal(table.stage, 1);
});

test("a baseline model change below MIN_N leaves the guard without a verdict and every fitted row the policy cell", () => {
  const w = world();
  baseline(w, { count: 25 });
  addPulls(w, { cell: "slow-high", model: "model-s2", count: 3, usd: 10, session: SESSION2 });
  addPulls(w, { cell: "task-high", model: "model-t", count: 20, usd: 2 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 20, usd: 2 });
  const { report, table } = guarded(w);
  assert.deepEqual([report.baseline.generation, report.baseline.n], ["model-s2", 3]);
  assert.equal(report.verdict, "none");
  assert.deepEqual(table.rows, { cost: { "*": "slow-high" }, speed: { "*": "slow-high" } });
  assert.equal(table.estimates["*"]["slow-high"].older["model-s"].n, 25, "the old baseline is reported beside the new one");
});

test("a fallback member counts under the model it was dispatched on, not its last turn's", () => {
  const w = world();
  w.features.push(pull(40, "smol-high"));
  w.members.push(impl(40, "smol-high", { dispatchModel: "model-a", model: "ollama", ending: "provider" }));
  const [u] = units(w);
  assert.equal(u.generation, "model-a");
  assert.equal(u.status, "left-out", "a provider ending is neither's, as before");
  assert.equal(tally([u])[0].generation, "model-a");
});

test("a rescue at another cell neither changes the Pull's generation nor leaves its spend", () => {
  const w = world();
  w.features.push(pull(41, "smol-high"));
  w.members.push(
    impl(41, "smol-high", { dispatchModel: "model-a", ending: "budget", cost: 1 }),
    impl(41, "slow-high", { agent: "impl-41-b", dispatchModel: "model-c", ending: "pr", pr: "141", cost: 4 }),
  );
  w.tiers.push(ruling(41, 141));
  merged(w, 141);
  const [u] = units(w);
  assert.deepEqual([u.cell, u.generation, u.status, u.spend], ["smol-high", "model-a", "counted", 5]);
});

test("of two Admissible rows on different dispatch models, the first dispatched names the Pull's generation, whatever the file order", () => {
  const w = world();
  w.features.push(pull(42, "smol-high"));
  w.members.push(
    impl(42, "smol-high", { agent: "impl-42-b", dispatchModel: "model-b", ending: "pr", pr: "142" }),
    impl(42, "smol-high", { dispatchModel: "model-a", ending: "abort" }),
  );
  assert.equal(units(w)[0].generation, "model-a");
});

test("an implementer row with a blank dispatch model is not Admissible, and a Pull with no other is excluded per cell", () => {
  const w = world();
  addPulls(w, { cell: "smol-high", model: "model-a", count: 1 });
  w.features.push(pull(43, "smol-high"));
  w.members.push(impl(43, "smol-high", { dispatchModel: "", model: "model-a", ending: "pr", pr: "143" }));
  w.tiers.push(ruling(43, 143));
  merged(w, 143);
  const [, blank] = units(w);
  assert.deepEqual([blank.status, blank.generation], ["excluded", null]);
  const [t] = tally(units(w));
  assert.deepEqual([t.generation, t.n, t.excluded, t.older], ["model-a", 1, 1, []]);
});

test("a cell that returns to an earlier model rejoins that generation's Pulls: A → B → A reads A newest, with the first span's Pulls", () => {
  const w = world();
  addPulls(w, { cell: "smol-high", model: "model-a", count: 2 });
  addPulls(w, { cell: "smol-high", model: "model-b", count: 3, session: SESSION2 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 1, session: SESSION3 });
  const [t] = tally(units(w));
  assert.deepEqual([t.generation, t.n, t.older.map((o) => [o.generation, o.n])], ["model-a", 3, [["model-b", 3]]]);
});

test("the newest generation is the latest Pull's by session id, then file order, never by file order alone", () => {
  // The later session's Pull is written to the file first.
  const w = world();
  addPulls(w, { cell: "smol-high", model: "model-b", count: 1, session: SESSION2 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 1 });
  assert.equal(tally(units(w))[0].generation, "model-b");
  // Within one session, the later row in the file is the later Pull.
  const same = world();
  addPulls(same, { cell: "smol-high", model: "model-b", count: 1 });
  addPulls(same, { cell: "smol-high", model: "model-a", count: 1 });
  assert.equal(tally(units(same))[0].generation, "model-a");
});

test("within one session the later Pull places its generation even when an earlier Pull shares it: A, B, A reads A newest", () => {
  const w = world();
  addPulls(w, { cell: "smol-high", model: "model-a", count: 1 });
  addPulls(w, { cell: "smol-high", model: "model-b", count: 1 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 1 });
  const [t] = tally(units(w));
  assert.deepEqual([t.generation, t.n, t.older.map((o) => o.generation)], ["model-a", 2, ["model-b"]]);
});

test("a cell's older generations are listed newest first: A, then B, then C reads C newest, then B, then A", () => {
  const w = world();
  addPulls(w, { cell: "smol-high", model: "model-a", count: 1 });
  addPulls(w, { cell: "smol-high", model: "model-b", count: 1, session: SESSION2 });
  addPulls(w, { cell: "smol-high", model: "model-c", count: 1, session: SESSION3 });
  const [t] = tally(units(w));
  assert.deepEqual([t.generation, t.older.map((o) => o.generation)], ["model-c", ["model-b", "model-a"]]);
});

test("dispatch order is the session, then the bare name, then a shorter retry suffix before a longer, then by letter, a member's path prefix aside", () => {
  // Each Pull's Admissible rows, written in the file in the order given; the first dispatched names its generation.
  const pullOf = (ticket, rows) => {
    const w = world();
    w.features.push(pull(ticket, "smol-high"));
    w.members.push(...rows.map(([agent, dispatchModel, o = {}]) => impl(ticket, "smol-high", { agent, dispatchModel, ...o })));
    return units(w)[0].generation;
  };
  assert.equal(pullOf(60, [["impl-60", "model-later", { session: SESSION2 }], ["impl-60-b", "model-b"]]), "model-b", "an earlier session's retry before a later session's bare name");
  assert.equal(pullOf(61, [["impl-61-aa", "model-aa"], ["impl-61-z", "model-z"]]), "model-z", "`-z` before `-aa`");
  assert.equal(pullOf(62, [["impl-62-c", "model-c"], ["impl-62-b", "model-b"]]), "model-b", "`-b` before `-c`");
  assert.equal(pullOf(63, [["impl-63-b", "model-b", { member: "team/impl-63-b" }], ["impl-63", "model-a", { member: "team/impl-63" }]]), "model-a", "the bare name before its retry under a path prefix");
});

test("the fit names each cell's newest generation as the guard does: ranked over every windowed Pull, whatever the fit's restriction or the stratum", () => {
  const w = world();
  baseline(w);
  // task-high: 21 on A the fit reads, then one on C that a live B classifier
  // routed — outside the fit's rows, yet C is task-high's newest generation.
  addPulls(w, { cell: "task-high", model: "model-a", count: 21, usd: 1 });
  addPulls(w, { cell: "task-high", model: "model-c", count: 1, session: SESSION2 });
  Object.assign(w.features.at(-1), { exploration_draw: "", sizing_src: "llm" });
  // smol-high: 25 light on A, 22 light on B, then one heavy on A, so A is newest in the light stratum too.
  addPulls(w, { cell: "smol-high", model: "model-a", count: 25, usd: 2 });
  addPulls(w, { cell: "smol-high", model: "model-b", count: 22, usd: 2, session: SESSION2 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 1, usd: 2, session: SESSION3 });
  w.features.at(-1).criteria = "9";
  const { report, table } = guarded(w);
  const newest = Object.fromEntries(report.cells.map((c) => [c.cell, c.generation]));
  assert.deepEqual([newest["task-high"], newest["smol-high"]], ["model-c", "model-a"]);
  for (const [s, cells] of Object.entries(table.estimates)) {
    for (const [cell, e] of Object.entries(cells)) assert.equal(e.generation, newest[cell], `${s} ${cell}`);
  }
  const task = table.estimates["*"]["task-high"];
  assert.deepEqual([task.n, task.older["model-a"].n], [0, 21]);
  assert.deepEqual([table.estimates.light["smol-high"].n, table.estimates.light["smol-high"].older["model-b"].n], [25, 22]);
  assert.ok(Object.values(table.rows).every((set) => Object.values(set).every((c) => c !== "task-high")), "A's 21 at $1 clear MIN_N, but A is not task-high's newest generation");
});

test("the guard's median, router $ and interval read each generation's own Pulls, the interval against the baseline's newest generation alone", () => {
  const w = world();
  baseline(w, { model: "model-s0", usd: 40 });
  baseline(w, { session: SESSION2 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 3, usd: 20 });
  addPulls(w, { cell: "smol-high", model: "model-b", count: 3, usd: 2, session: SESSION2 });
  for (const f of w.features) if (f.chosen_cell === "smol-high") f.router_usd = f.session === SESSION2 ? "0.5" : "0.25";
  const { report } = guarded(w);
  const smol = report.cells.find((c) => c.cell === "smol-high");
  assert.deepEqual([smol.generation, smol.median_usd, smol.router_usd], ["model-b", 2, 1.5]);
  assert.deepEqual(smol.older.map((o) => [o.generation, o.median_usd, o.router_usd, o.usd_diff_ci95]), [["model-a", 20, 0.75, null]]);
  // Every Pull of a generation costs the same, so every resample's difference is B's $2 less the baseline newest's $10.
  assert.deepEqual(smol.usd_diff_ci95, [-8, -8]);
});

test("on the committed corpus, smol-high's newest generation is claude-haiku-5-5, and the fit and the guard print the same per-generation figures", () => {
  const read = (f) => readFileSync(new URL(`../docs/metrics/${f}`, import.meta.url), "utf8");
  const members = parseMemberTsv(read("member-outcomes.tsv"));
  const tiers = parseTierOutcomes(read("tier-outcomes.tsv"));
  const features = parseFeatures(read("ticket-features.tsv"));
  // Every ruled PR read as merged: the guard's one view the fit, which sees no PR state, shares.
  const prs = [...new Set(tiers.map((t) => t.pr))].map((number) => ({ number: Number(number), state: "MERGED" }));
  const g = (f) => [f.generation, f.n_pulls, f.n_merged, f.n_failed, f.mean_usd];
  const guard = computeReport({ members, tiers, features, prs }).cells.map((c) => [c.cell, g(c), c.older.map(g)]);
  const e = ([generation, f]) => [generation, f.n, f.merged, f.failed, f.usd_per_merged === null ? null : Number(f.usd_per_merged.toFixed(2))];
  const fit = Object.entries(fitTable({ prior, features, members, verdicts: tiers, guard: { tripped: [], n: {}, window_start: WINDOW_START } }).estimates["*"] ?? {})
    .map(([c, f]) => [c, e([f.generation, f]), Object.entries(f.older).map(e)]);
  assert.deepEqual(fit, guard);
  assert.equal(guard.find(([c]) => c === "smol-high")[1][0], "claude-haiku-5-5");
});
