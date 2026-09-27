// Derivation script for docs/research/tier-readout.md (issue #2031).
//
// Pure over the two TSVs it reads — no clock, no network, no gh. Run from the
// repo root:
//   node docs/research/tier-readout-derive.mjs docs/metrics/member-outcomes.tsv docs/metrics/tier-outcomes.tsv
//
// What it does, in order:
//   1. Runs the exact pairing query from member-outcomes.tsv's own header
//      (session+model, subagent_type-keyed) to find every within-run pair —
//      a session that dispatched BOTH `fleet-implementer` and
//      `fleet-implementer-alt` at different models.
//   2. member-outcomes.tsv's `pr` column is blank for every implementer row
//      (an `impl-<n>` dispatch is named for its TICKET, not the PR it has not
//      opened yet) — confirmed below by a direct count. The join to
//      tier-outcomes.tsv (the verdicts) therefore runs on `ticket`, not `pr`.
//   3. Reports three views: (a) row-level over every joined dispatch in a
//      paired session — flagged because two sessions dispatch far more `top`
//      tickets than `alt` ones and would otherwise dominate it; (b)
//      session-level — one paired observation per session, alt-mean vs
//      top-mean, equal weight per session regardless of how many tickets it
//      ran; (c) the same descriptives over EVERY row of tier-outcomes.tsv by
//      its `tier` label, unpaired and confounded, labelled as such.
//   4. Converts tokens to $ with the pricing table below (Anthropic list
//      prices, cache-write 5-minute tier + output only — see the doc for the
//      citation and the input/cache-read gap this leaves).
//   5. Flags which paired rows are tier-check-verified (run_date on or after
//      2026-09-20, the cutoff this ticket names — none are, as of this
//      corpus) and which model/effort combination each date pairs.

import { readFileSync } from "node:fs";

const [, , MO_PATH, TO_PATH] = process.argv;
if (!MO_PATH || !TO_PATH) {
  console.error("usage: node tier-readout-derive.mjs <member-outcomes.tsv> <tier-outcomes.tsv>");
  process.exit(1);
}

const MO_COLS = [
  "session", "run_date", "role", "member", "model", "effort", "ticket", "pr",
  "tokens_cache_create", "tokens_out", "wall_s", "turns", "agent", "harness", "subagent_type",
];
const TO_COLS = [
  "run_date", "pr", "ticket", "class", "tier", "closed_own_ticket", "minted_false_claim",
  "note", "sizing", "profile", "loc", "files",
];

function parseTsv(text, cols) {
  return text
    .split("\n")
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const cells = line.split("\t");
      const o = {};
      cols.forEach((c, i) => (o[c] = cells[i] ?? ""));
      return o;
    });
}

const mo = parseTsv(readFileSync(MO_PATH, "utf8"), MO_COLS);
const to = parseTsv(readFileSync(TO_PATH, "utf8"), TO_COLS);

// --- Confirm member-outcomes.tsv's `pr` column is unusable for the implementer join ---
const implRows = mo.filter((o) => /(^|:)fleet-implementer(-alt)?$/.test(o.subagent_type));
const implWithPr = implRows.filter((o) => o.pr).length;
console.log(`# implementer-dispatch rows: ${implRows.length}, of which ${implWithPr} carry a non-blank pr`);
console.log(`# -> join runs on ticket, not pr (see comment above).\n`);

// --- 1. The pairing query, verbatim logic from member-outcomes.tsv's header ---
const isAlt = (o) => /(^|:)fleet-implementer-alt$/.test(o.subagent_type);
const isTop = (o) => /(^|:)fleet-implementer$/.test(o.subagent_type);

const altBySession = {};
const topBySession = {};
for (const o of mo.filter(isAlt)) (altBySession[o.session] ??= []).push(o);
for (const o of mo.filter(isTop)) (topBySession[o.session] ??= []).push(o);

const pairedSessions = [];
for (const session of Object.keys(altBySession)) {
  const alts = altBySession[session];
  const tops = topBySession[session] || [];
  if (tops.length && alts.some((a) => tops.some((t) => t.model !== a.model))) {
    pairedSessions.push({ session, run_date: alts[0].run_date, alts, tops });
  }
}
const pairDates = new Set(pairedSessions.map((p) => p.run_date));
console.log(`# PAIR COUNT (member-outcomes.tsv header query): ${pairedSessions.length} pairs across ${pairDates.size} run_dates`);
console.log(`# run_dates: ${[...pairDates].sort().join(", ")}\n`);

// The one session the header itself flags as an empty comparison (both arms
// resolved to the same model despite different declared definitions) is
// excluded by construction (alts.some(model !== ) above); confirm it exists.
const excluded = Object.keys(altBySession).filter((s) => {
  const alts = altBySession[s], tops = topBySession[s] || [];
  return tops.length && !alts.some((a) => tops.some((t) => t.model !== a.model));
});
console.log(`# sessions with an alt+top dispatch that resolved to the SAME model (excluded from pairs): ${excluded.length}`);
for (const s of excluded) {
  const a = altBySession[s][0];
  console.log(`#   ${s} run_date=${a.run_date} model=${a.model} alt#=${altBySession[s].length} top#=${(topBySession[s]||[]).length}`);
}
console.log();

// --- 2. Join to tier-outcomes.tsv on ticket ---
const toByTicket = {};
for (const r of to) if (r.ticket) (toByTicket[r.ticket] ??= []).push(r);

function attachTier(row) {
  const matches = row.ticket ? toByTicket[row.ticket] : undefined;
  return matches && matches.length === 1 ? { ...row, tier_row: matches[0] } : { ...row, tier_row: null };
}

const joinedRows = [];
for (const p of pairedSessions) {
  for (const a of p.alts) {
    const j = attachTier(a);
    if (j.tier_row) joinedRows.push({ arm: "alt", session: p.session, ...j });
  }
  for (const t of p.tops) {
    const j = attachTier(t);
    if (j.tier_row) joinedRows.push({ arm: "top", session: p.session, ...j });
  }
}
console.log(`# joined rows (ticket resolves to exactly one tier-outcomes row): alt=${joinedRows.filter(r=>r.arm==="alt").length} top=${joinedRows.filter(r=>r.arm==="top").length}\n`);

// --- Pricing (Anthropic list prices, cache-write 5-minute tier + output only) ---
// Source: https://platform.claude.com/docs/en/about-claude/pricing (read 2026-09-27).
// $/MTok: [cache_write_5m, output]
const PRICING = {
  "claude-opus-5": [6.25, 25],
  "claude-sonnet-5": [2.50, 10],       // introductory rate, permanent per the same page as of 2026-09-27
  "claude-haiku-4-5": [1.25, 5],
  "claude-haiku-4-5-20251001": [1.25, 5],
  "claude-opus-4-7": [6.25, 25],
  "claude-opus-4-8": [6.25, 25],
};
function dollarsFor(row) {
  const p = PRICING[row.model];
  if (!p) return null;
  const [cw, out] = p;
  return (Number(row.tokens_cache_create || 0) / 1e6) * cw + (Number(row.tokens_out || 0) / 1e6) * out;
}

function fails(r) {
  return r.tier_row.minted_false_claim === "yes" || r.tier_row.closed_own_ticket === "no";
}
function stats(rows) {
  const n = rows.length;
  const failN = rows.filter(fails).length;
  const nums = (k) => rows.map((r) => Number(r[k] || 0));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);
  const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const dollars = rows.map(dollarsFor).filter((d) => d !== null);
  return {
    n, failN, failRate: n ? failN / n : NaN,
    meanCacheCreate: mean(nums("tokens_cache_create")), medianCacheCreate: median(nums("tokens_cache_create")),
    meanOut: mean(nums("tokens_out")), medianOut: median(nums("tokens_out")),
    meanWall: mean(nums("wall_s")), meanTurns: mean(nums("turns")),
    meanDollars: mean(dollars), medianDollars: median(dollars), dollarsN: dollars.length,
  };
}
function fmt(s) {
  const d = (x) => (Number.isFinite(x) ? x.toFixed(0) : "n/a");
  const p = (x) => (Number.isFinite(x) ? (x * 100).toFixed(1) + "%" : "n/a");
  const usd = (x) => (Number.isFinite(x) ? "$" + x.toFixed(2) : "n/a");
  return `n=${s.n} fail=${s.failN}/${s.n} (${p(s.failRate)}) cacheCreate mean/med=${d(s.meanCacheCreate)}/${d(s.medianCacheCreate)} ` +
    `out mean/med=${d(s.meanOut)}/${d(s.medianOut)} wall_s mean=${d(s.meanWall)} turns mean=${d(s.meanTurns)} ` +
    `$ mean/med (n=${s.dollarsN})=${usd(s.meanDollars)}/${usd(s.medianDollars)}`;
}

console.log("## 3a. Row-level, all joined dispatches in paired sessions (CONFOUNDED by ticket count per session — see 3b for the session-level view)");
console.log("ALT (fleet-implementer-alt):", fmt(stats(joinedRows.filter((r) => r.arm === "alt"))));
console.log("TOP (fleet-implementer):    ", fmt(stats(joinedRows.filter((r) => r.arm === "top"))));
console.log();

function byKey(rows, key) {
  const g = {};
  for (const r of rows) (g[r.tier_row[key] || "(blank)"] ??= []).push(r);
  return g;
}
console.log("Stratified by sizing:");
for (const arm of ["alt", "top"]) {
  const rows = joinedRows.filter((r) => r.arm === arm);
  const g = byKey(rows, "sizing");
  for (const k of Object.keys(g).sort()) console.log(`  ${arm} sizing=${k}:`, fmt(stats(g[k])));
}
console.log("Stratified by profile:");
for (const arm of ["alt", "top"]) {
  const rows = joinedRows.filter((r) => r.arm === arm);
  const g = byKey(rows, "profile");
  for (const k of Object.keys(g).sort()) console.log(`  ${arm} profile=${k}:`, fmt(stats(g[k])));
}
console.log();

// --- 3b. Session-level paired comparison: one observation per session ---
console.log("## 3b. Session-level, one paired observation per session (equal weight regardless of ticket count)");
const bySession = {};
for (const r of joinedRows) (bySession[r.session] ??= { alt: [], top: [] })[r.arm].push(r);
const sessPairs = Object.entries(bySession).filter(([, g]) => g.alt.length && g.top.length);
console.log(`sessions with a verdicted ticket on BOTH sides: ${sessPairs.length} of ${pairedSessions.length} paired sessions\n`);
const sessAltMeans = [], sessTopMeans = [];
for (const [session, g] of sessPairs) {
  const altS = stats(g.alt), topS = stats(g.top);
  sessAltMeans.push(altS);
  sessTopMeans.push(topS);
  console.log(`  session ${session} run_date=${g.alt[0].run_date}: ALT ${fmt(altS)}`);
  console.log(`  session ${session} run_date=${g.alt[0].run_date}: TOP ${fmt(topS)}`);
}
function meanOfMeans(arr, key) {
  const v = arr.map((s) => s[key]).filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}
console.log("\nAcross-session averages of the per-session means:");
for (const key of ["failRate", "meanCacheCreate", "meanOut", "meanWall", "meanTurns", "meanDollars"]) {
  console.log(`  ${key}: alt=${meanOfMeans(sessAltMeans, key)?.toFixed?.(3)} top=${meanOfMeans(sessTopMeans, key)?.toFixed?.(3)}`);
}
console.log();

// --- 3c. Confounded: every row of tier-outcomes.tsv by its `tier` label ---
console.log("## 3c. CONFOUNDED — every row of tier-outcomes.tsv, unpaired, grouped by its own `tier` label (no token columns exist on this file)");
function toStats(rows) {
  const n = rows.length;
  const failN = rows.filter((r) => r.minted_false_claim === "yes" || r.closed_own_ticket === "no").length;
  return { n, failN, failRate: n ? failN / n : NaN };
}
for (const tier of ["opus", "sonnet"]) {
  const rows = to.filter((r) => r.tier === tier);
  const s = toStats(rows);
  console.log(`  tier=${tier}: n=${s.n} fail=${s.failN} (${(s.failRate * 100).toFixed(1)}%)`);
}
console.log();

// --- 3d. Effort-matched vs effort-mismatched dates. Effort (thinking level)
// is NOT controlled across the corpus: this box's own operator override drift
// (see the T1 ticket on this map) means some dates ran top capped to `high`
// while alt ran uncapped at `xhigh` (alt gets STRICTLY MORE thinking budget
// than top on those dates), and other dates ran both arms at the same level.
// A tier comparison that pools both regimes is comparing two different
// experiments. Classify each paired run_date by whether every alt row's
// effort matches every top row's effort that date, then rerun 3a's pooled
// row-level stat split by regime.
const dateEffort = {};
for (const p of pairedSessions) {
  const key = p.run_date;
  (dateEffort[key] ??= { alt: new Set(), top: new Set() });
  for (const a of p.alts) dateEffort[key].alt.add(a.effort);
  for (const t of p.tops) dateEffort[key].top.add(t.effort);
}
const matchedDates = new Set(), mismatchedDates = new Set();
for (const [date, e] of Object.entries(dateEffort)) {
  const altOnly = [...e.alt], topOnly = [...e.top];
  const sameLevel = altOnly.length === 1 && topOnly.length === 1 && altOnly[0] === topOnly[0];
  (sameLevel ? matchedDates : mismatchedDates).add(date);
}
console.log("## 3d. Row-level, split by whether the paired date ran alt and top at the SAME declared effort level");
console.log(`effort-matched dates: ${[...matchedDates].sort().join(", ")}`);
console.log(`effort-mismatched dates (alt strictly more thinking budget than top): ${[...mismatchedDates].sort().join(", ")}`);
for (const [label, dates] of [["MATCHED", matchedDates], ["MISMATCHED", mismatchedDates]]) {
  console.log(`-- ${label}`);
  for (const arm of ["alt", "top"]) {
    const rows = joinedRows.filter((r) => r.arm === arm && dates.has(r.run_date));
    console.log(`  ${arm}:`, fmt(stats(rows)));
  }
}
console.log();
// --- 5. tier-check-verified rows and effort combinations per date ---
console.log("## 5. Effort combination per paired run_date, and tier-check-verified rows (run_date >= 2026-09-20)");
for (const date of Object.keys(dateEffort).sort()) {
  const verified = date >= "2026-09-20" ? "TIER-CHECK-VERIFIED" : "not verified (before this ticket's 2026-09-20 cutoff)";
  const e = dateEffort[date];
  console.log(`  ${date}: alt effort={${[...e.alt].join(",")}} top effort={${[...e.top].join(",")}}  [${verified}]`);
}
console.log();

// --- Appendix: the full per-pair, per-member listing (ticket ask #1) ---
console.log("## Appendix: every dispatched member of every pair, both arms, in run_date order");
const orderedPairs = [...pairedSessions].sort((a, b) => a.run_date.localeCompare(b.run_date));
let pairIdx = 0;
for (const p of orderedPairs) {
  pairIdx++;
  console.log(`\n### Pair ${pairIdx} — session \`${p.session}\` — run_date ${p.run_date}\n`);
  console.log("| arm | member | ticket | model | effort | verdict (closed/minted) | cache_create | out | wall_s | turns |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const [arm, list] of [["alt", p.alts], ["top", p.tops]]) {
    for (const row of list) {
      const t = row.ticket ? toByTicket[row.ticket]?.[0] : undefined;
      const v = t ? `${t.closed_own_ticket || "?"}/${t.minted_false_claim || "?"}` : "(no tier-outcomes row)";
      console.log(`| ${arm} | ${row.member} | ${row.ticket} | ${row.model} | ${row.effort} | ${v} | ${row.tokens_cache_create} | ${row.tokens_out} | ${row.wall_s} | ${row.turns} |`);
    }
  }
}
