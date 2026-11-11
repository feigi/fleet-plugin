// pull-attribution.mjs: the one booking the cost guard (pr-cost.mjs) and the
// router's fit (ticket-router.mjs) both read. Each case is run through the
// attribution itself and through both consumers, so a figure the two scripts
// print differently fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatTsv, parseTsv as parseMemberTsv } from "../plugin/scripts/member-outcomes.mjs";
import { RulingError, formatRow, parseTierOutcomes } from "../plugin/scripts/tier-outcomes.mjs";
import { AttributionError, FEATURE_COLUMNS, TRIP_POINTS, admissibleRow, attribute, bootUnit, bootstrapDiffCI, compareCells, parseFeatures, tally } from "../plugin/scripts/pull-attribution.mjs";
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
  window_start: null, n_rows: 0, cells: ["slow-high", "task-high", "smol-high"], burn_in: true, splits: {},
  rows: { "*": "slow-high" }, classifier: { b: null, tau: null }, estimates: {}, guard: { tripped: [], n: {} },
};
// The prior with one split, where the old light/heavy rule drew its line on the criteria count: five or fewer is `criteria<=5`.
const SPLIT = { ...prior, splits: { "*": { input: "criteria", cut: 5 } } };
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

test("one ticket Pulled twice, each Pull carrying its own ruled PR: each Pull takes its own Ruling, though the later row is both Pulls' date-floor candidate", () => {
  const w = world();
  w.features.push(pull(60, "slow-high"), pull(60, "task-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(
    impl(60, "slow-high", { ending: "pr", pr: "160", cost: 2 }),
    impl(60, "task-high", { session: SESSION2, run_date: "2026-10-05", ending: "pr", pr: "161", cost: 3 }),
  );
  w.tiers.push(ruling(60, 160, { minted_false_claim: "yes" }), ruling(60, 161, { run_date: "2026-10-05" }));
  merged(w, 160);
  merged(w, 161);
  const [first, second] = units(w);
  assert.deepEqual([first.status, first.merged, first.pr, first.ruling?.minted_false_claim, first.falseClaims], ["counted", true, "160", "yes", 1]);
  assert.deepEqual([second.status, second.merged, second.pr, second.ruling?.minted_false_claim, second.falseClaims], ["counted", true, "161", "no", 0]);
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "slow-high": cell({ n: 1, merged: 1, failed: 1, usd: 2 }), "task-high": cell({ n: 1, merged: 1, usd: 3 }) });
  assert.deepEqual(fit, guard);
});

test("an excluded earlier Pull keeps its own PR's Ruling when a later-appended row rules the counted later Pull's PR", () => {
  const w = world();
  w.features.push(pull(3545, "task-high"), pull(3545, "slow-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(
    impl(3545, "slow-high", { ending: "pr", pr: "3606", cost: 2 }),
    impl(3545, "slow-high", { session: SESSION2, run_date: "2026-10-05", ending: "pr", pr: "3696", cost: 3 }),
  );
  w.tiers.push(ruling(3545, 3606, { minted_false_claim: "yes" }), ruling(3545, 3696, { run_date: "2026-10-07" }));
  merged(w, 3606);
  merged(w, 3696);
  const [earlier, later] = units(w);
  assert.deepEqual([earlier.status, earlier.merged, earlier.pr, earlier.ruling?.pr, earlier.claims, earlier.falseClaims], ["excluded", true, "3606", "3606", 1, 1]);
  assert.deepEqual([later.status, later.merged, later.pr, later.ruling?.pr, later.claims, later.falseClaims], ["counted", true, "3696", "3696", 1, 0]);
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "slow-high": cell({ n: 1, merged: 1, usd: 3 }), "task-high": cell({ excluded: 1 }) });
  assert.deepEqual(fit, guard);
});

test("a Pull takes its carried PR's Ruling even when that row is dated before the Pull; a Pull that does not carry it does not", () => {
  const w = world();
  w.features.push(pull(61, "slow-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(impl(61, "slow-high", { session: SESSION2, run_date: "2026-10-05", ending: "pr", pr: "1610", cost: 2 }));
  w.tiers.push(ruling(61, 1610));
  merged(w, 1610);
  const [u] = units(w);
  assert.deepEqual([u.status, u.merged, u.pr], ["counted", true, "1610"]);
  assert.deepEqual(figures(w).guard, { "slow-high": cell({ n: 1, merged: 1, usd: 2 }) });
  w.members[0].pr = "";
  const [floored] = units(w);
  assert.deepEqual([floored.merged, floored.pr], [false, null], "the date floor still holds for a Pull that does not carry the PR");
});

test("a carrier takes the latest row in file order naming its PR, whatever its ticket, and that row's ticket is refused on the same terms as its own", () => {
  const w = world();
  w.features.push(pull(64, "slow-high"));
  w.members.push(impl(64, "slow-high", { ending: "pr", pr: "164", cost: 2 }));
  w.tiers.push(ruling(64, 164), ruling(65, 164, { run_date: "2026-10-02", minted_false_claim: "yes" }));
  merged(w, 164);
  const [u] = units(w);
  assert.deepEqual([u.status, u.merged, u.ruling?.ticket, u.falseClaims], ["counted", true, "65", 1]);
  const p = parsed(w);
  const bad = { ...p.tiers[1], closed_own_ticket: "maybe" };
  assert.throws(() => attribute({ ...p, tiers: [p.tiers[0], bad], prs: w.prs, windowStart: DAY }),
    (e) => e instanceof RulingError && e.message === "ticket #65 (PR #164): closed_own_ticket is 'maybe', expected yes or no");
});

test("a carrier bound to another ticket's row still has its own ticket's ruling rows refused", () => {
  const w = world();
  w.features.push(pull(68, "slow-high"));
  w.members.push(impl(68, "slow-high", { ending: "pr", pr: "168", cost: 2 }));
  w.tiers.push(ruling(69, 168), ruling(68, 1680));
  merged(w, 168);
  assert.deepEqual(units(w)[0].ruling?.ticket, "69");
  const p = parsed(w);
  const bad = { ...p.tiers[1], closed_own_ticket: "maybe" };
  assert.throws(() => attribute({ ...p, tiers: [p.tiers[0], bad], prs: w.prs, windowStart: DAY }),
    (e) => e instanceof RulingError && e.message === "ticket #68 (PR #1680): closed_own_ticket is 'maybe', expected yes or no");
});

test("a Pull carrying two ruled PRs binds the PR whose ruling row is later in file order, whatever its implementer rows' order", () => {
  const w = world();
  w.features.push(pull(66, "slow-high"));
  w.members.push(
    impl(66, "slow-high", { ending: "budget", pr: "166", cost: 2 }),
    impl(66, "slow-high", { agent: "impl-66-b", ending: "pr", pr: "167", cost: 3 }),
  );
  w.tiers.push(ruling(66, 167), ruling(66, 166, { minted_false_claim: "yes" }));
  merged(w, 166);
  merged(w, 167);
  const [u] = units(w);
  assert.deepEqual([u.status, u.merged, u.pr, u.ruling?.pr, u.falseClaims], ["counted", true, "166", "166", 1]);
});

test("a carrier before the window takes no PR: an in-window Pull whose date-floor candidate names that PR takes it, unpriced", () => {
  const w = world();
  const EARLY = "2026-10-01T10-00-00-000Z_01a00000-0000-7000-8000-000000000003";
  w.features.push(pull(70, "slow-high", { session: EARLY, run_date: "2026-10-01" }), pull(70, "task-high"));
  w.members.push(
    impl(70, "slow-high", { session: EARLY, run_date: "2026-10-01", ending: "pr", pr: "700", cost: 2 }),
    impl(70, "task-high", { ending: "hollow", cost: 3 }),
  );
  w.tiers.push(ruling(70, 700));
  merged(w, 700);
  const us = units(w);
  assert.deepEqual(us.map((u) => [u.status, u.merged, u.pr]), [["unpriced", true, "700"]]);
});

test("two Pulls carrying the same PR with its ruling dated between them: the later Pull, its carrier, takes it though the row predates it", () => {
  const w = world();
  w.features.push(pull(71, "slow-high"), pull(71, "task-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(
    impl(71, "slow-high", { ending: "budget", pr: "171", cost: 2 }),
    impl(71, "task-high", { session: SESSION2, run_date: "2026-10-05", ending: "pr", pr: "171", cost: 3 }),
  );
  w.tiers.push(ruling(71, 171, { run_date: "2026-10-04" }));
  merged(w, 171);
  const [first, second] = units(w);
  assert.deepEqual([first.status, first.merged, first.pr], ["counted", false, null]);
  assert.deepEqual([second.status, second.merged, second.pr], ["counted", true, "171"]);
});

test("a carrier bound to a `+`-joined row has every one of its tickets' ruling rows refused, not just the first", () => {
  const w = world();
  w.features.push(pull(72, "slow-high"));
  w.members.push(impl(72, "slow-high", { ending: "pr", pr: "172", cost: 2 }));
  w.tiers.push(ruling(73, 1730, { run_date: "2026-10-02" }), ruling("72+73", 172));
  merged(w, 172);
  assert.deepEqual(units(w)[0].ruling?.ticket, "72+73");
  const p = parsed(w);
  const bad = { ...p.tiers[0], closed_own_ticket: "maybe" };
  assert.throws(() => attribute({ ...p, tiers: [bad, p.tiers[1]], prs: w.prs, windowStart: DAY }),
    (e) => e instanceof RulingError && e.message === "ticket #73 (PR #1730): closed_own_ticket is 'maybe', expected yes or no");
});

test("two Pulls carrying the same PR: its merge counts once, for the later in file order, and the earlier stays unruled", () => {
  const w = world();
  w.features.push(pull(62, "slow-high"), pull(62, "task-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(
    impl(62, "slow-high", { ending: "budget", pr: "162", cost: 2 }),
    impl(62, "task-high", { session: SESSION2, run_date: "2026-10-05", ending: "pr", pr: "162", cost: 3 }),
  );
  w.tiers.push(ruling(62, 162, { run_date: "2026-10-05" }));
  merged(w, 162);
  const [first, second] = units(w);
  assert.deepEqual([first.merged, first.pr, first.claims], [false, null, 0]);
  assert.deepEqual([second.status, second.merged, second.pr], ["counted", true, "162"]);
  const { guard, fit } = figures(w);
  assert.deepEqual(guard, { "slow-high": cell({ n: 1 }), "task-high": cell({ n: 1, merged: 1, usd: 3 }) });
  assert.deepEqual(fit, guard);
});

test("a Pull carrying no ruled PR still takes its date-floor Ruling, unpriced, beside a carrier-bound Pull of the same ticket", () => {
  const w = world();
  w.features.push(pull(63, "slow-high"), pull(63, "task-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(
    impl(63, "slow-high", { ending: "pr", pr: "163", cost: 2 }),
    impl(63, "task-high", { session: SESSION2, run_date: "2026-10-05", ending: "hollow", cost: 3 }),
  );
  w.tiers.push(ruling(63, 163), ruling(63, 1630, { run_date: "2026-10-05" }));
  merged(w, 163);
  merged(w, 1630);
  const [first, second] = units(w);
  assert.deepEqual([first.status, first.merged, first.pr], ["counted", true, "163"]);
  assert.deepEqual([second.status, second.merged, second.pr], ["unpriced", true, "1630"]);
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
    { cell: "slow-high", generation: null, n: 0, merged: 0, claims: 0, failed: 0, spend: 0, workS: 0, pulls: [], excluded: 1, left_out: 0, unpriced: 0, untimed: 0, pending: 0, by_hand: 0, no_ruling: 0, older: [] },
    { cell: "task-high", generation: null, n: 1, merged: 1, claims: 1, failed: 0, spend: 3, workS: 600, pulls: [counted], excluded: 0, left_out: 1, unpriced: 1, untimed: 1, pending: 1, by_hand: 0, no_ruling: 0, older: [] },
  ]);
});

const DERIVED = "review run-aaaaaaa1 at 1111111, no record: counted no survived and no unverified finding";
const DERIVED_RECORD = "review run-aaaaaaa1 at 1111111, record dispositions-fix-pr-20.json: survived[0] false-claim \"x\" — and a --note";

test("tally: by_hand counts the counted merged Pulls whose Ruling's note is not one append derives, on both derived forms, per generation", () => {
  const w = world();
  const notes = { 201: DERIVED, 202: DERIVED_RECORD, 203: "backfill: ruled from the merged PR's review", 204: "", 205: "n" };
  for (const [t, note] of Object.entries(notes)) {
    const pr = Number(t) + 1000;
    w.features.push(pull(t, "task-high"));
    w.members.push(impl(t, "task-high", { ending: "pr", pr: String(pr) }));
    w.tiers.push(ruling(t, pr, { note }));
    merged(w, pr);
  }
  const [t] = tally(units(w));
  assert.deepEqual([t.merged, t.by_hand], [5, 3]);
  // A hand-given Ruling on a PR that is not merged is no merged Pull, so it is not counted:
  // OPEN makes the Pull pending, and CLOSED leaves it counted but not merged.
  for (const [state, status] of [["OPEN", "pending"], ["CLOSED", "counted"]]) {
    const unmerged = world();
    unmerged.features.push(pull(206, "task-high"));
    unmerged.members.push(impl(206, "task-high", { ending: "pr", pr: "1206" }));
    unmerged.tiers.push(ruling(206, 1206, { note: "by hand" }));
    merged(unmerged, 1206, state);
    const us = units(unmerged);
    assert.equal(us[0].status, status, state);
    assert.deepEqual([tally(us)[0].merged, tally(us)[0].by_hand], [0, 0], state);
  }
});

test("the fit's estimates carry by_hand, the guard's count over the same Pulls", () => {
  const w = world();
  const notes = { 241: DERIVED, 242: "by hand", 243: DERIVED_RECORD, 244: "by hand again" };
  for (const [t, note] of Object.entries(notes)) {
    const pr = Number(t) + 1000;
    w.features.push(pull(t, "task-high"));
    w.members.push(impl(t, "task-high", { ending: "pr", pr: String(pr) }));
    w.tiers.push(ruling(t, pr, { note }));
    merged(w, pr);
  }
  const p = parsed(w);
  const est = fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: {}, window_start: DAY } }).estimates["*"]["task-high"];
  assert.deepEqual([est.merged, est.by_hand], [4, 2]);
  assert.equal(computeReport({ ...p, prs: w.prs }).cells[0].by_hand, est.by_hand);
});

test("tally: by_hand is per generation, so an older generation's hand-given Rulings are not the newest's", () => {
  const w = world();
  w.features.push(pull(211, "task-high"), pull(212, "task-high", { session: SESSION2, run_date: "2026-10-05" }));
  w.members.push(
    impl(211, "task-high", { ending: "pr", pr: "1211", dispatchModel: "model-a" }),
    impl(212, "task-high", { ending: "pr", pr: "1212", dispatchModel: "model-b", session: SESSION2, run_date: "2026-10-05" }),
  );
  w.tiers.push(ruling(211, 1211, { note: "by hand" }), ruling(212, 1212, { note: DERIVED }));
  merged(w, 1211);
  merged(w, 1212);
  const [t] = tally(units(w));
  assert.deepEqual([t.generation, t.by_hand, t.older.map((o) => [o.generation, o.by_hand])], ["model-b", 0, [["model-a", 1]]]);
});

test("attribute: a Pull whose PR merged with no Ruling is noRuling and still not merged, and no_ruling counts it whatever its status", () => {
  const w = world();
  w.features.push(pull(221, "task-high"), pull(222, "task-high"), pull(223, "task-high"));
  w.members.push(
    impl(221, "task-high", { ending: "pr", pr: "1221" }),
    impl(222, "task-high", { ending: "pr", pr: "1222", cost: "" }),
    impl(223, "task-high", { ending: "pr", pr: "1223" }),
  );
  merged(w, 1221);
  merged(w, 1222);
  merged(w, 1223, "CLOSED");
  const us = units(w);
  assert.deepEqual(us.map((u) => [u.noRuling, u.merged, u.status]), [[true, false, "counted"], [true, false, "unpriced"], [false, false, "counted"]]);
  assert.equal(tally(us)[0].no_ruling, 2);
  assert.equal(tally(us)[0].merged, 0, "the counted Pull is not merged");
});

test("attribute: no PR state means no noRuling, and a Pull that holds a Ruling, or whose PR another Pull holds the Ruling of, is not noRuling", () => {
  const w = world();
  w.features.push(pull(231, "task-high"), pull(232, "task-high"));
  w.members.push(
    impl(231, "task-high", { ending: "pr", pr: "1231" }),
    // The retry of the same ticket opened the same PR, so only the later Pull carries it.
    impl(232, "task-high", { ending: "pr", pr: "1231" }),
  );
  w.tiers.push(ruling(232, 1231));
  merged(w, 1231);
  assert.deepEqual(units(w).map((u) => u.noRuling), [false, false]);
  const bare = world();
  bare.features.push(pull(233, "task-high"));
  bare.members.push(impl(233, "task-high", { ending: "pr", pr: "1233" }));
  assert.equal(units(bare, null)[0].noRuling, false, "with no PR states there is nothing to say merged");
  assert.equal(units(bare, [{ number: 1233, state: "MERGED" }])[0].noRuling, true);
});

test("attribute: a Pull whose merged PR another Pull took the Ruling of by date, not by carrying it, is not noRuling", () => {
  const w = world();
  const later = { session: SESSION2, run_date: "2026-10-05" };
  w.features.push(pull(251, "task-high"), pull(251, "task-high", later), pull(252, "task-high", later));
  w.members.push(
    impl(251, "task-high", { ending: "pr", pr: "1251" }),
    // The retry carries PR 1251 too and binds to its own later ruling row, 1252's.
    impl(251, "task-high", { ...later, ending: "pr", pr: "1251" }),
    impl(251, "task-high", { ...later, agent: "impl-251-b", ending: "pr", pr: "1252" }),
    impl(252, "task-high", { ...later, ending: "budget" }),
  );
  // So 1251's Ruling, of ticket 252, goes to 252's Pull by the date floor.
  w.tiers.push(ruling(252, 1251, later), ruling(251, 1252, later));
  merged(w, 1251);
  merged(w, 1252);
  const us = units(w);
  assert.deepEqual(us.map((u) => [u.pull.ticket, u.pr, u.noRuling]), [["251", null, false], ["251", "1252", false], ["252", "1251", false]]);
  assert.equal(tally(us)[0].no_ruling, 0, "1251's one merge is held by a Ruling, so no Pull counts it as merged with none");
});

test("parseFeatures refuses a ticket, or a non-blank parent, that is not an issue number, naming the row and the value", () => {
  const head = FEATURE_COLUMNS.join("\t");
  const row = (ticket, parent) => FEATURE_COLUMNS.map((c) => ({ ticket, parent, chosen_cell: "slow-high" })[c] ?? "").join("\t");
  for (const t of ["007", "0", "00", "7x"]) {
    assert.throws(() => parseFeatures(`${head}\n${row("7", "")}\n${row(t, "")}\n`),
      { message: `ticket-features.tsv row 2: ticket ${JSON.stringify(t)} is not an issue number` });
  }
  for (const p of ["05", "0", "7x"]) {
    assert.throws(() => parseFeatures(`${head}\n${row("7", "")}\n${row("7", p)}\n`),
      { message: `ticket-features.tsv row 2: parent ${JSON.stringify(p)} is not blank or an issue number` });
  }
  const rows = parseFeatures(`${head}\n${row("7", "")}\n${row("10", "")}\n${row("7", "3177")}\n${row("10", "10")}\n`);
  assert.deepEqual(rows.map((r) => [r.ticket, r.parent]), [["7", ""], ["10", ""], ["7", "3177"], ["10", "10"]]);
});

test("parseFeatures reads the named-path, title and version columns by name, and blank from a header written before them", () => {
  const named = ["named_paths", "named_lines", "dirs", "title", "plugin_version"];
  assert.deepEqual(FEATURE_COLUMNS.slice(FEATURE_COLUMNS.indexOf("parent") + 1, -1), named, "appended after parent, in this order");
  const values = { ticket: "7", chosen_cell: "slow-high", named_paths: "plugin/a.mjs docs/b.md:3-9", named_lines: "12 -", dirs: "2", title: "a title", plugin_version: "1.2.3" };
  const text = (cols) => `${cols.join("\t")}\n${cols.map((c) => values[c] ?? "").join("\t")}\n`;
  const [withThem] = parseFeatures(text(FEATURE_COLUMNS));
  assert.deepEqual(named.map((c) => withThem[c]), named.map((c) => values[c]));
  const [without] = parseFeatures(text(FEATURE_COLUMNS.filter((c) => !named.includes(c))));
  assert.deepEqual(named.map((c) => without[c]), named.map(() => ""));
  assert.deepEqual({ ...without, ...Object.fromEntries(named.map((c) => [c, withThem[c]])) }, withThem, "every other column reads the same");
});

test("parseFeatures reads assignment_prob, the last column, as written, and blank — unknown, never 1 or 0 — from a header written before it", () => {
  assert.equal(FEATURE_COLUMNS.at(-1), "assignment_prob");
  const text = (cols, prob) => `${cols.join("\t")}\n${cols.map((c) => ({ ticket: "7", chosen_cell: "slow-high", assignment_prob: prob })[c] ?? "").join("\t")}\n`;
  for (const prob of ["1", "4/5", "1/15"]) assert.equal(parseFeatures(text(FEATURE_COLUMNS, prob))[0].assignment_prob, prob);
  const [without] = parseFeatures(text(FEATURE_COLUMNS.slice(0, -1), "4/5"));
  assert.equal(without.assignment_prob, "");
  assert.equal(without.ticket, "7");
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
function guarded(w, from = prior) {
  const p = parsed(w);
  const report = computeReport({ ...p, prs: w.prs });
  const guard = readGuard(guardFile(report, "t"));
  const table = fitTable({ prior: from, features: p.features, members: p.members, verdicts: p.tiers, guard });
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
  const { report, guard, table } = guarded(w, SPLIT);

  const smol = report.cells.find((c) => c.cell === "smol-high");
  assert.deepEqual([smol.generation, smol.n_merged, smol.mean_usd, smol.fail_rate], ["model-b", 22, 2, 0]);
  assert.deepEqual(smol.older.map((o) => [o.generation, o.n_merged, o.mean_usd, o.fail_rate]), [["model-a", 25, 20, 0.4]]);
  assert.deepEqual(report.tripped, [], "the guard judges B alone, and B does not trip");
  assert.equal(report.verdict, "ok");
  const entry = guardFile(report, "t").cells.find((c) => c.cell === "smol-high");
  assert.deepEqual({ cell: entry.cell, generation: entry.generation, n: entry.n, mean_usd: entry.mean_usd, fail_rate: entry.fail_rate, untimed: entry.untimed },
    { cell: "smol-high", generation: "model-b", n: 22, mean_usd: 2, fail_rate: 0, untimed: 0 });
  assert.deepEqual(entry.older.map((o) => [o.generation, o.n_merged, o.n_failed]), [["model-a", 25, 10]], "model-a stays nested under the entry, never its own cells[] one");
  assert.equal(guard.n["smol-high"], 22);

  const est = table.estimates["*"]["smol-high"];
  assert.deepEqual([est.generation, est.n, est.merged, est.usd_per_merged, est.minutes_per_merged, est.fail_rate], ["model-b", 22, 22, 2, 10, 0]);
  assert.deepEqual(Object.keys(est.older), ["model-a"]);
  const older = est.older["model-a"];
  assert.deepEqual([older.n, older.usd_per_merged, older.minutes_per_merged, older.fail_rate, older.untimed], [25, 20, 30, 0.4, 0]);
  assert.equal(table.estimates["criteria<=5"]["smol-high"].older["model-a"].minutes_per_merged, 30, "a group's row keeps each older generation's time too");
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
  assert.deepEqual([bootUnit({ spend: 3, merged: false, stretch: "s" }), bootUnit({ spend: 3, merged: true, stretch: "s" })], [{ value: 3, per: 0, weigh: 1, stretch: "s" }, { value: 3, per: 1, weigh: 1, stretch: "s" }]);
  const w = world();
  baseline(w);
  addPulls(w, { cell: "task-high", model: "model-t", count: 20, usd: 3 });
  addPulls(w, { cell: "task-high", model: "model-t", count: 10, usd: 3, state: "CLOSED" });
  const th = computeReport({ ...parsed(w), prs: w.prs }).cells.find((c) => c.cell === "task-high");
  assert.deepEqual([th.n_pulls, th.n_merged, th.mean_usd], [30, 20, 4.5]);
  // Booked as merged, every resample of task-high would read $3 a PR, and the range would be [-7, -7].
  const ci = th.usd_diff_ci95;
  assert.ok(ci[0] < -5.5 && -5.5 < ci[1], `a range around $4.50 − $10: ${ci}`);
  assert.deepEqual(bootstrapDiffCI(Array(30).fill({ value: 3, per: 1, weigh: 1 }), Array(20).fill({ value: 10, per: 1, weigh: 1 })), [-7, -7]);
});

test("bootUnit takes a measure: `minutes` is a Pull's work time over 60, `usd` its spend and the default, each weighing one Pull, `fail` its false claims in points over its claims, weighing its claims; bootstrapDiffCI reads the unit's value", () => {
  const u = { spend: 3, workS: 90, merged: true, claims: 4, falseClaims: 1, stretch: "s" };
  assert.deepEqual(
    [bootUnit(u), bootUnit(u, "usd"), bootUnit(u, "minutes"), bootUnit(u, "fail")],
    [{ value: 3, per: 1, weigh: 1, stretch: "s" }, { value: 3, per: 1, weigh: 1, stretch: "s" }, { value: 1.5, per: 1, weigh: 1, stretch: "s" }, { value: 100, per: 4, weigh: 4, stretch: "s" }],
  );
  assert.deepEqual(bootstrapDiffCI(Array(20).fill(bootUnit({ ...u, workS: 60 }, "minutes")), Array(20).fill(bootUnit({ ...u, workS: 150 }, "minutes"))), [-1.5, -1.5]);
});

test("the comparison is one function: both scripts import compareCells from pull-attribution.mjs and carry no stretch or pooling of their own, and neither imports the other", () => {
  const src = (f) => readFileSync(new URL(`../plugin/scripts/${f}`, import.meta.url), "utf8");
  const guard = src("pr-cost.mjs"), fit = src("ticket-router.mjs");
  for (const s of [guard, fit]) {
    assert.match(s, /import \{[^}]*\bcompareCells\b[^}]*\} from "\.\/pull-attribution\.mjs"/);
    assert.doesNotMatch(s, /import \{[^}]*\b(?:bootUnit|bootstrapDiffCI|underFloor)\b[^}]*\} from "\.\/pull-attribution\.mjs"/);
    assert.doesNotMatch(s, /function (?:bootstrapDiffCI|mulberry32|pool|sharedStretches|stretchesOf|weekOf|reachesMargin)\b|const TRIP_POINTS\b|\bgetUTCDay\b|\bDate\.UTC\b|\bBigInt\b/);
  }
  assert.doesNotMatch(guard, /from "\.\/ticket-router\.mjs"/);
  assert.doesNotMatch(fit, /from "\.\/pr-cost\.mjs"/);
});

test("a model change re-enters burn-in: 3 merged on B after 30 on A is the guard's n, neither adopted nor tripped, and 20 merged on B end it again", () => {
  const w = world();
  baseline(w);
  addPulls(w, { cell: "task-high", model: "model-t", count: 20, usd: 9 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 30, usd: 2, fails: 30 });
  assert.equal(guarded(w).table.burn_in, false, "every starting Cell has its MIN_N merged PRs on its model: burn-in is over");
  addPulls(w, { cell: "smol-high", model: "model-b", count: 3, usd: 2, session: SESSION2 });
  const { report, guard, table } = guarded(w);
  assert.equal(guardFile(report, "t").cells.find((c) => c.cell === "smol-high").n, 3);
  assert.equal(guard.n["smol-high"], 3);
  assert.deepEqual(report.tripped, [], "A's failures do not trip B, and B is short of MIN_N");
  assert.equal(table.rows.cost["*"], "slow-high", "B is short of MIN_N, so nothing adopts it");
  assert.equal(table.burn_in, true, "the new generation starts at 0 merged PRs, so burn-in is back");
  addPulls(w, { cell: "smol-high", model: "model-b", count: 16, usd: 2, session: SESSION2 });
  assert.equal(guarded(w).table.burn_in, true, "19 merged on B: one short");
  addPulls(w, { cell: "smol-high", model: "model-b", count: 1, usd: 2, session: SESSION2 });
  assert.equal(guarded(w).table.burn_in, false, "20 merged on B end it again, whatever A holds");
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
  // smol-high: 25 on A and 22 on B at one criterion, then one on A at 9, past the split, so A is newest in the group it left too.
  addPulls(w, { cell: "smol-high", model: "model-a", count: 25, usd: 2 });
  addPulls(w, { cell: "smol-high", model: "model-b", count: 22, usd: 2, session: SESSION2 });
  addPulls(w, { cell: "smol-high", model: "model-a", count: 1, usd: 2, session: SESSION3 });
  w.features.at(-1).criteria = "9";
  const { report, table } = guarded(w, SPLIT);
  const newest = Object.fromEntries(report.cells.map((c) => [c.cell, c.generation]));
  assert.deepEqual([newest["task-high"], newest["smol-high"]], ["model-c", "model-a"]);
  for (const [s, cells] of Object.entries(table.estimates)) {
    for (const [cell, e] of Object.entries(cells)) assert.equal(e.generation, newest[cell], `${s} ${cell}`);
  }
  const task = table.estimates["*"]["task-high"];
  assert.deepEqual([task.n, task.older["model-a"].n], [0, 21]);
  const few = table.estimates["criteria<=5"]["smol-high"];
  assert.deepEqual([few.n, few.older["model-b"].n], [25, 22]);
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

// ---------------------------------------------------------------------------
// Stretches: the weeks and installs a comparison is matched over
// ---------------------------------------------------------------------------

// A Pull of `ticket` at slow-high on `date`, in a session that opens with it, its row recording `version`.
const dated = (ticket, date, version = "", o = {}) => pull(ticket, "slow-high", {
  run_date: date, session: `${date}T10-00-00-000Z_01a00000-0000-7000-8000-000000000000`, plugin_version: version, ...o,
});
// The stretch each features row falls in, in file order. With no member rows every Pull is excluded, and each unit still carries its stretch.
const stretchesOf = (rows, windowStart = null) => {
  const w = world();
  w.features.push(...rows);
  return attribute({ ...parsed(w), windowStart }).map((u) => u.stretch);
};
const sameStretch = (s, ...at) => at.every((i) => s[i] === s[at[0]]);

test("a stretch is one UTC calendar week of run_date, Monday first: Sunday ends a week, Monday opens the next, a year's turn is no cut", () => {
  const s = stretchesOf([
    dated(1, "2026-10-03"), dated(2, "2026-10-04"), dated(3, "2026-10-05"), dated(4, "2026-10-11"), dated(5, "2026-10-12"),
    dated(6, "2026-12-28"), dated(7, "2027-01-03"), dated(8, "2027-01-04"),
  ]);
  assert.ok(sameStretch(s, 0, 1), "Saturday and Sunday close the week of Monday 2026-09-28");
  assert.notEqual(s[1], s[2], "Monday 2026-10-05 opens the next week");
  assert.ok(sameStretch(s, 2, 3), "Monday through Sunday are one week");
  assert.notEqual(s[3], s[4]);
  assert.ok(sameStretch(s, 5, 6), "Monday 2026-12-28 and Sunday 2027-01-03 are one week across the new year");
  assert.notEqual(s[6], s[7]);
  assert.equal(new Set(s).size, 5, "five weeks in all");
});

test("a recorded plugin_version change cuts a week in two, the cut before the Pull that records the new version", () => {
  const s = stretchesOf([dated(1, "2026-10-05", "1.0.0"), dated(2, "2026-10-06", "1.0.0"), dated(3, "2026-10-07", "1.1.0"), dated(4, "2026-10-08", "1.1.0")]);
  assert.ok(sameStretch(s, 0, 1));
  assert.ok(sameStretch(s, 2, 3));
  assert.notEqual(s[1], s[2], "one week, two stretches");
  // The new version holds on into the next week, which a week's turn cuts on its own.
  const next = stretchesOf([dated(1, "2026-10-07", "1.0.0"), dated(2, "2026-10-08", "1.1.0"), dated(3, "2026-10-12", "1.1.0"), dated(4, "2026-10-13", "1.1.0")]);
  assert.deepEqual([sameStretch(next, 2, 3), next[1] !== next[2], next[0] !== next[1]], [true, true, true]);
});

test("a blank plugin_version is unknown, never itself a cut: it stays in the stretch in force, and the first version recorded cuts nothing", () => {
  const blankBetween = stretchesOf([dated(1, "2026-10-05", "1.0.0"), dated(2, "2026-10-06", ""), dated(3, "2026-10-07", "1.0.0")]);
  assert.ok(sameStretch(blankBetween, 0, 1, 2), "the same version either side of a blank");
  const blankFirst = stretchesOf([dated(1, "2026-10-05", ""), dated(2, "2026-10-06", "1.0.0"), dated(3, "2026-10-07", "1.0.0")]);
  assert.ok(sameStretch(blankFirst, 0, 1, 2), "rows before the column, then the first version recorded");
  const changeOverBlank = stretchesOf([dated(1, "2026-10-05", "1.0.0"), dated(2, "2026-10-06", ""), dated(3, "2026-10-07", "1.1.0")]);
  assert.ok(sameStretch(changeOverBlank, 0, 1), "the blank stays with the version before it");
  assert.notEqual(changeOverBlank[1], changeOverBlank[2], "the cut is where the new version is first recorded");
  const allBlank = stretchesOf([dated(1, "2026-10-05", ""), dated(2, "2026-10-09", ""), dated(3, "2026-10-12", "")]);
  assert.deepEqual([sameStretch(allBlank, 0, 1), allBlank[1] !== allBlank[2]], [true, true], "a record that never names a version is cut by the week alone");
});

test("a return to an earlier version cuts again: 1.0.0, 1.1.0, 1.0.0 in one week are three stretches", () => {
  const s = stretchesOf([dated(1, "2026-10-05", "1.0.0"), dated(2, "2026-10-06", "1.1.0"), dated(3, "2026-10-07", "1.0.0")]);
  assert.equal(new Set(s).size, 3);
});

test("the cut is global and read in session order: a Pull that records no version is cut by another's, wherever it sits in the file", () => {
  // Cell B's Pulls record no version, yet B's second Pull is on the far side of A's change in the sequence of every Pull.
  const rows = [
    dated(1, "2026-10-05", "", { chosen_cell: "task-high" }),
    dated(2, "2026-10-05", "1.0.0", { session: "2026-10-05T10-30-00-000Z_x" }),
    dated(3, "2026-10-06", "1.1.0", { session: "2026-10-06T10-00-00-000Z_x" }),
    dated(4, "2026-10-07", "", { session: "2026-10-07T10-00-00-000Z_x", chosen_cell: "task-high" }),
  ];
  const s = stretchesOf(rows);
  assert.notEqual(s[0], s[3], "the one cell's two Pulls fall either side of the other's version change");
  assert.ok(sameStretch(s, 0, 1), "and the first Pulls, before the change, share theirs");
  assert.ok(sameStretch(s, 2, 3));
  // Session id first, then file order: the same Pulls filed out of order read the same.
  const shuffled = stretchesOf([rows[3], rows[1], rows[0], rows[2]]);
  assert.deepEqual([sameStretch(shuffled, 2, 1), sameStretch(shuffled, 0, 3), shuffled[0] !== shuffled[1]], [true, true, true]);
  // Where sessions tie, file order decides.
  const tied = stretchesOf([dated(1, "2026-10-05", "1.0.0"), dated(2, "2026-10-05", "1.1.0"), dated(3, "2026-10-05", "1.1.0")]);
  assert.deepEqual([tied[0] !== tied[1], sameStretch(tied, 1, 2)], [true, true]);
});

test("the record is the windowed Pulls: a Pull before windowStart is no part of the sequence, so its version cuts nothing inside it", () => {
  // Were the earlier Pull read, 1.0.0 then 1.1.0 would cut between the two windowed Pulls; with the window it is the first version recorded.
  const rows = [dated(1, "2026-10-02", "1.0.0"), dated(2, "2026-10-06", ""), dated(3, "2026-10-07", "1.1.0")];
  const s = stretchesOf(rows, "2026-10-05");
  assert.equal(s.length, 2, "the earlier Pull is no unit");
  assert.ok(sameStretch(s, 0, 1));
});

// ---------------------------------------------------------------------------
// compareCells: two cells' Pulls over the stretches in which both were drawn
// ---------------------------------------------------------------------------

// A counted Pull in `stretch`: merged and one claim, spending $1 over a minute, unless told.
const unit = (stretch, o = {}) => ({ stretch, merged: true, claims: 1, falseClaims: 0, spend: 1, workS: 60, ...o });
// `n` such Pulls, the first `fails` of them a false claim.
const units3 = (stretch, n, { fails = 0, ...o } = {}) => Array.from({ length: n }, (_, i) => unit(stretch, { falseClaims: i < fails ? 1 : 0, ...o }));
const W1 = "2026-10-05/0", W2 = "2026-10-12/0", W3 = "2026-10-19/0";

test("compareCells over one shared stretch is the cell's own figures: $ and minutes per merged PR, the fail rate, and the floor as counts", () => {
  const cell = units3(W1, 20, { fails: 7, spend: 5, workS: 120 });
  const base = units3(W1, 20, { fails: 4, spend: 10, workS: 300 });
  const m = compareCells(cell, base);
  assert.equal(m.stretches, 1);
  assert.deepEqual(m.cell, { n: 20, merged: 20, claims: 20, failed: 7, usd_per_merged: 5, minutes_per_merged: 2, fail_rate: 0.35 });
  assert.deepEqual(m.base, { n: 20, merged: 20, claims: 20, failed: 4, usd_per_merged: 10, minutes_per_merged: 5, fail_rate: 0.2 });
  assert.equal(m.underFloor, true, "3 of 20 over the baseline is exactly 15 points");
  assert.equal(compareCells(units3(W1, 20, { fails: 6 }), base).underFloor, false, "2 of 20 over is 10 points");
  assert.equal(compareCells(units3(W1, 20, { fails: 8 }), units3(W1, 20, { fails: 5 })).underFloor, true, "40% against 25%");
  assert.equal(compareCells(units3(W1, 20, { fails: 2 }), units3(W1, 30, { fails: 3 })).underFloor, false, "2 of 20 against 3 of 30 is equal");
  assert.deepEqual(m.range("usd"), bootstrapDiffCI(cell.map((u) => bootUnit(u, "usd")), base.map((u) => bootUnit(u, "usd"))), "the range is the bootstrap of those Pulls");
  assert.deepEqual(compareCells(units3(W1, 30, { spend: 3 }), units3(W1, 20, { spend: 10 })).range("usd"), [-7, -7]);
});

test("compareCells counts an unmerged Pull's spend and no merged PR, and a Pull's claims, not its merges, for the fail rate", () => {
  const cell = [...units3(W1, 20, { spend: 3 }), ...units3(W1, 10, { spend: 3, merged: false, claims: 0 })];
  const m = compareCells(cell, units3(W1, 20, { spend: 10 }));
  assert.deepEqual([m.cell.n, m.cell.merged, m.cell.claims, m.cell.usd_per_merged], [30, 20, 20, 4.5]);
  const two = compareCells([unit(W1, { claims: 2, falseClaims: 1 })], [unit(W1, { claims: 4, falseClaims: 1 })]);
  assert.deepEqual([two.cell.fail_rate, two.base.fail_rate], [0.5, 0.25]);
});

test("compareCells reads no floor against a side with no claim, even in one stretch: a fail rate of 5 of 20 against none is not under it, nor none against 3 of 20", () => {
  const noClaims = (n) => units3(W1, n, { claims: 0 });
  for (const [cell, base] of [[units3(W1, 20, { fails: 5 }), noClaims(20)], [noClaims(20), units3(W1, 20, { fails: 3 })]]) {
    const m = compareCells(cell, base);
    assert.deepEqual([m.stretches, m.cell.fail_rate, m.base.fail_rate, m.underFloor, m.range("fail")], [1, null, null, false, null]);
  }
});

test("compareCells takes only the stretches in which both cells have Pulls, and the base's others change nothing", () => {
  const cell = [...units3(W1, 12, { fails: 6, spend: 8 }), ...units3(W2, 10, { fails: 2, spend: 6 })];
  const base = [...units3(W2, 10, { fails: 1, spend: 10 }), ...units3(W3, 30, { fails: 0, spend: 1 })];
  const m = compareCells(cell, base);
  assert.equal(m.stretches, 1, "only W2 is shared");
  assert.deepEqual([m.cell.n, m.cell.merged, m.cell.claims, m.cell.failed], [10, 10, 10, 2], "the cell's Pulls of W1 take no part");
  assert.deepEqual([m.base.n, m.base.merged, m.base.claims, m.base.failed], [10, 10, 10, 1], "nor the base's of W3");
  const alone = compareCells(units3(W2, 10, { fails: 2, spend: 6 }), units3(W2, 10, { fails: 1, spend: 10 }));
  assert.deepEqual({ ...m, range: m.range("usd") }, { ...alone, range: alone.range("usd") }, "exactly the comparison of W2 alone");
});

test("compareCells with no shared stretch compares nothing: no merged PR on either side, no figure, no range, never under the floor", () => {
  const m = compareCells(units3(W1, 25, { fails: 25, spend: 99 }), units3(W2, 25, { fails: 0 }));
  assert.equal(m.stretches, 0);
  assert.deepEqual(m.cell, { n: 0, merged: 0, claims: 0, failed: 0, usd_per_merged: null, minutes_per_merged: null, fail_rate: null });
  assert.deepEqual(m.base, m.cell);
  assert.deepEqual([m.underFloor, m.range("usd"), m.range("minutes"), m.range("fail")], [false, null, null, null]);
  assert.equal(compareCells([], units3(W1, 20)).stretches, 0);
  assert.equal(compareCells(units3(W1, 20), []).range("usd"), null);
});

test("compareCells pools within each stretch: a shift that hits both cells in a stretch cancels, however unevenly the cells were drawn across the stretches", () => {
  // Both cells fail half their claims in W1 and a tenth in W2, but the cell was drawn mostly in W1 and the base mostly in W2.
  const cell = [...units3(W1, 20, { fails: 10 }), ...units3(W2, 10, { fails: 1 })];
  const base = [...units3(W1, 10, { fails: 5 }), ...units3(W2, 40, { fails: 4 })];
  const m = compareCells(cell, base);
  assert.equal(m.stretches, 2);
  assert.equal(m.cell.fail_rate, m.base.fail_rate, "no gap within either stretch");
  assert.equal(m.underFloor, false);
  // Pooled over their Pulls instead, the cell's 11 of 30 against the base's 9 of 50 would be 18.7 points over the floor.
  const together = (units) => units.map((u) => ({ ...u, stretch: undefined }));
  assert.equal(compareCells(together(cell), together(base)).underFloor, true);

  // The $ per merged PR: each stretch's gap is the same whatever the stretch's own level, so a shift per stretch leaves the pooled gap and its range alone.
  const priced = [...units3(W1, 20, { spend: 5 }), ...units3(W2, 10, { spend: 7 })];
  const against = [...units3(W1, 10, { spend: 8 }), ...units3(W2, 40, { spend: 9 })];
  const shift = (units, by) => units.map((u) => ({ ...u, spend: u.spend + by[u.stretch] }));
  const gap = (c, b) => { const x = compareCells(c, b); return [x.cell.usd_per_merged - x.base.usd_per_merged, x.range("usd")]; };
  const [pooled, range] = gap(priced, against);
  // Gaps of -3 in W1 and -2 in W2, weighted by 20·10/30 and 10·40/50.
  assert.ok(Math.abs(pooled - -36 / (200 / 30 + 8)) < 1e-9, `the pooled gap is -2.4545…: ${pooled}`);
  assert.deepEqual(range, [-2.45, -2.45]);
  const by = { [W1]: 100, [W2]: 0.5 };
  const [shifted, shiftedRange] = gap(shift(priced, by), shift(against, by));
  assert.ok(Math.abs(shifted - pooled) < 1e-9);
  assert.deepEqual(shiftedRange, range);
});

test("a cell that ran in one stretch is compared with the base's Pulls of that stretch alone, whatever the base did in its others", () => {
  const cell = units3(W2, 20, { fails: 8, spend: 6 });
  const alone = units3(W2, 25, { fails: 7, spend: 10 });
  // Elsewhere the base failed nothing at $1: over its whole run it would read 7 of 105, 33 points under the cell's 40%.
  const base = [...units3(W1, 40, { spend: 1 }), ...alone, ...units3(W3, 40, { spend: 1 })];
  const m = compareCells(cell, base);
  const only = compareCells(cell, alone);
  assert.deepEqual({ ...m, range: m.range("usd") }, { ...only, range: only.range("usd") });
  assert.deepEqual([m.stretches, m.base.n, m.base.fail_rate, m.base.usd_per_merged, m.underFloor], [1, 25, 0.28, 10, false], "8 of 20 against 7 of 25 is 12 points");
});

test("a stretch in which a side merged nothing still counts that side's spend in its $ per merged PR: every Pull of a shared stretch is kept", () => {
  // The cell spent $100 on each of 5 abandoned Pulls in W1 and $1 on each of 5 merged in W2; the base merged its 5 of each at $10.
  const cell = [...units3(W1, 5, { merged: false, claims: 0, spend: 100 }), ...units3(W2, 5, { spend: 1 })];
  const base = [...units3(W1, 5, { spend: 10 }), ...units3(W2, 5, { spend: 10 })];
  const m = compareCells(cell, base);
  // Equal weeks weigh alike: $50.50 a Pull over half a merged PR a Pull, so $101, not the $1 of the merged week alone.
  assert.deepEqual([m.stretches, m.cell.n, m.cell.merged, m.cell.usd_per_merged, m.base.usd_per_merged, m.cell.minutes_per_merged], [2, 10, 5, 101, 10, 2]);
  assert.deepEqual(m.range("usd"), [91, 91], "the bootstrap pools every resample the same way");
  // Merged only in different stretches, each side's figure still carries the spend of the week it merged nothing in.
  const apart = compareCells([...units3(W1, 20), ...units3(W2, 5, { merged: false, claims: 0 })], [...units3(W1, 5, { merged: false, claims: 0 }), ...units3(W2, 20)]);
  assert.deepEqual([apart.cell.merged, apart.base.merged, apart.cell.usd_per_merged, apart.base.usd_per_merged, apart.cell.minutes_per_merged], [20, 20, 2, 2, 2]);
  assert.deepEqual([apart.cell.fail_rate, apart.underFloor, apart.range("usd")], [null, false, [0, 0]], "no week holds a claim on both sides: no fail rate, so no floor");
});

test("compareCells reads the floor in exact counts across stretches: three stretches each exactly 15 points over are 15 points over, and one short is not", () => {
  assert.equal(TRIP_POINTS, 15);
  const drawn = (fails) => fails.flatMap((n, k) => units3([W1, W2, W3][k], 20, { fails: n }));
  // 7 of 20 against 4, and 5 against 2, three times over: each gap is 15 points exactly, which pooled in floating point
  // reads as 14.999999999999996.
  for (const base of [4, 2]) {
    assert.equal(compareCells(drawn([base + 3, base + 3, base + 3]), drawn([base, base, base])).underFloor, true, `${base + 3} of 20 against ${base}, in each of three stretches`);
  }
  const base = drawn([4, 4, 4]);
  assert.equal(compareCells(drawn([7, 7, 6]), base).underFloor, false, "a stretch short of the margin");
  assert.equal(compareCells(drawn([8, 7, 6]), base).underFloor, true, "a stretch over and a stretch under, equally weighted, average to the margin");
});

test("the bootstrap resamples within each stretch: stretches that differ in level but not in gap give a range with no width, as one pooled stretch would not", () => {
  const cell = [...units3(W1, 20, { spend: 10 }), ...units3(W2, 20, { spend: 30 })];
  const base = [...units3(W1, 20, { spend: 12 }), ...units3(W2, 20, { spend: 32 })];
  const units = (pulls) => pulls.map((u) => bootUnit(u, "usd"));
  assert.deepEqual(bootstrapDiffCI(units(cell), units(base)), [-2, -2]);
  const flat = (pulls) => units(pulls).map((u) => ({ ...u, stretch: undefined }));
  const [lo, hi] = bootstrapDiffCI(flat(cell), flat(base));
  assert.ok(hi - lo > 1, `resampled as one, the mix of W1 and W2 moves the range: [${lo}, ${hi}]`);
});

test("compareCells' fail range is in points of the fail rate: 18 of 32 against 9 of 32 is 28.125 points, its range about it", () => {
  const [lo, hi] = compareCells(units3(W1, 32, { fails: 18 }), units3(W1, 32, { fails: 9 })).range("fail");
  assert.ok(lo > 0 && lo < 28.125 && hi > 28.125 && hi < 60, `a range about 28.1 points: [${lo}, ${hi}]`);
  assert.deepEqual(compareCells(units3(W1, 20, { fails: 4 }), units3(W1, 20, { fails: 4 })).range("fail").map((x) => Math.sign(x)), [-1, 1]);
});

test("on the committed corpus, smol-high is compared with slow-high only over the weeks both were drawn, and its fail-rate gap is the notes' 28 points, give or take the week", () => {
  const read = (f) => readFileSync(new URL(`../docs/metrics/${f}`, import.meta.url), "utf8");
  const members = parseMemberTsv(read("member-outcomes.tsv"));
  const tiers = parseTierOutcomes(read("tier-outcomes.tsv"));
  // The Pulls the notes read, to the end of October: a record that grows reads the same here.
  const features = parseFeatures(read("ticket-features.tsv")).filter((f) => f.run_date <= "2026-10-31");
  const prs = [...new Set(tiers.map((t) => t.pr))].map((number) => ({ number: Number(number), state: "MERGED" }));
  const cells = new Map(tally(attribute({ members, tiers, features, prs, windowStart: WINDOW_START })).map((t) => [t.cell, t]));
  const [smol, slow] = [cells.get("smol-high"), cells.get("slow-high")];
  const weeksOf = (t) => new Set(t.pulls.map((u) => u.stretch));
  const shared = [...weeksOf(smol)].filter((s) => weeksOf(slow).has(s));
  const m = compareCells(smol.pulls, slow.pulls);
  assert.deepEqual([m.stretches, shared.length, weeksOf(slow).size], [2, 2, 4], "smol-high ran in two of the four weeks slow-high did");
  assert.deepEqual([m.cell.failed, m.cell.claims], [18, 32], "the notes' 18 of 32");
  assert.deepEqual([m.base.n, m.base.n < slow.n, m.base.failed, m.base.claims], [63, true, 15, 63], "against slow-high's 63 Pulls of those weeks, not its 104");
  const gap = (m.cell.fail_rate - m.base.fail_rate) * 100;
  assert.ok(gap > 28 && gap < 36, `the notes read +28.1 points on a pool cut by session; cut by week it is ${gap.toFixed(1)}`);
  assert.equal(m.underFloor, true);
  const [lo, hi] = m.range("fail");
  assert.ok(lo > 0 && lo < gap && gap < hi && hi > 45 && hi < 56, `a range about it, as the notes' [3.1, 50.0]: [${lo}, ${hi}]`);
});
