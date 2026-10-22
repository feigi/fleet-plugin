// pull-attribution.mjs: the one booking the cost guard (pr-cost.mjs) and the
// router's fit (ticket-router.mjs) both read. Each case is run through the
// attribution itself and through both consumers, so a figure the two scripts
// print differently fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatTsv, parseTsv as parseMemberTsv } from "../plugin/scripts/member-outcomes.mjs";
import { formatRow, parseTierOutcomes } from "../plugin/scripts/tier-outcomes.mjs";
import { AttributionError, FEATURE_COLUMNS, admissibleRow, attribute, parseFeatures, tally } from "../plugin/scripts/pull-attribution.mjs";
import { WINDOW_START, computeReport } from "../plugin/scripts/pr-cost.mjs";
import { fitTable } from "../plugin/scripts/ticket-router.mjs";

const DAY = WINDOW_START;
const SESSION = "2026-10-03T10-00-00-000Z_01a00000-0000-7000-8000-000000000000";
const SESSION2 = "2026-10-05T10-00-00-000Z_01a00000-0000-7000-8000-000000000001";

const world = () => ({ members: [], tiers: [], features: [], prs: [] });
const member = (o) => ({
  session: SESSION, run_date: DAY, role: "implementer", member: o.agent, model: "claude-opus-5", effort: "high",
  ticket: "", pr: "", tokensCacheCreate: 0, tokensOut: 0, wallS: 0, turns: 1, harness: "omp", subagentType: "",
  tokensIn: 0, tokensCacheRead: 0, tokensCacheWrite1h: "", cost: 1, ending: "", ...o,
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
    n: c.n_pulls, merged: c.n_merged, failed: c.n_failed, excluded: c.excluded, left_out: c.left_out, unpriced: c.unpriced, usd: c.mean_usd,
  }]));
  const est = fitTable({ prior, features: p.features, members: p.members, verdicts: p.tiers, guard: { tripped: [], n: {}, window_start: DAY } }).estimates["*"] ?? {};
  const fit = Object.fromEntries(Object.entries(est).map(([c, e]) => [c, {
    n: e.n, merged: e.merged, failed: e.failed, excluded: e.excluded, left_out: e.left_out, unpriced: e.unpriced, usd: e.usd_per_merged,
  }]));
  return { guard, fit };
}
const units = (w, prs = w.prs) => attribute({ ...parsed(w), prs, windowStart: DAY });
const cell = (o) => ({ n: 0, merged: 0, failed: 0, excluded: 0, left_out: 0, unpriced: 0, usd: null, ...o });

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

test("tally counts each status per cell, and only counted Pulls enter n, merged, claims and spend", () => {
  const u = (cell, status, o = {}) => ({ cell, status, merged: false, claims: 0, falseClaims: 0, spend: 1, ...o });
  assert.deepEqual(tally([
    u("task-high", "counted", { merged: true, claims: 1, spend: 3 }), u("slow-high", "excluded"), u("task-high", "left-out"),
    u("task-high", "unpriced", { spend: null }), u("task-high", "pending"),
  ]), [
    { cell: "slow-high", n: 0, merged: 0, claims: 0, failed: 0, spend: 0, excluded: 1, left_out: 0, unpriced: 0, pending: 0 },
    { cell: "task-high", n: 1, merged: 1, claims: 1, failed: 0, spend: 3, excluded: 0, left_out: 1, unpriced: 1, pending: 1 },
  ]);
});

test("admissibleRow: the cell's own definition at its level with a resolved model, and nothing short of all three", () => {
  const row = { subagentType: "fleet-implementer-task-high", effort: "high", model: "m" };
  assert.equal(admissibleRow(row, "task-high"), true);
  assert.equal(admissibleRow({ ...row, effort: "medium" }, "task-high"), false);
  assert.equal(admissibleRow({ ...row, model: "" }, "task-high"), false);
  assert.equal(admissibleRow({ ...row, subagentType: "fleet-implementer" }, "task-high"), false);
  assert.equal(admissibleRow(row, "smol-high"), false);
});

test("on the committed corpus, the fit and the guard print the same per-cell n, merged and failed counts", () => {
  const read = (f) => readFileSync(new URL(`../docs/metrics/${f}`, import.meta.url), "utf8");
  const members = parseMemberTsv(read("member-outcomes.tsv"));
  const tiers = parseTierOutcomes(read("tier-outcomes.tsv"));
  const features = parseFeatures(read("ticket-features.tsv"));
  // Every ruled PR read as merged: the guard's one view the fit, which sees no PR state, shares.
  const prs = [...new Set(tiers.map((t) => t.pr))].map((number) => ({ number: Number(number), state: "MERGED" }));
  const guard = computeReport({ members, tiers, features, prs }).cells.map((c) => [c.cell, c.n_pulls, c.n_merged, c.n_failed]);
  const fit = Object.entries(fitTable({ prior, features, members, verdicts: tiers, guard: { tripped: [], n: {}, window_start: WINDOW_START } }).estimates["*"] ?? {})
    .map(([c, e]) => [c, e.n, e.merged, e.failed]);
  assert.deepEqual(fit, guard);
});
