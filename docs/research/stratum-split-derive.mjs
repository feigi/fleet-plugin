// How the light/heavy split divides this repository's Pulls — derive script for stratum-split.md.
// Usage: node docs/research/stratum-split-derive.mjs <checkout of e5040b9a>
// Reads the checkout's docs/metrics TSVs and router-table.json through its own plugin/scripts modules,
// and the cost guard of 2026-11-01 kept beside this script.
import { readFileSync } from "node:fs";
const W = process.argv[2];
const imp = (p) => import(`${W}/plugin/scripts/${p}`);
const { parseFeatures } = await imp("pull-attribution.mjs");
const { parseTsv } = await imp("member-outcomes.mjs");
const { parseTierOutcomes } = await imp("tier-outcomes.mjs");
const T = await imp("ticket-router.mjs");
const rd = (p) => readFileSync(`${W}/${p}`, "utf8");
const features = parseFeatures(rd("docs/metrics/ticket-features.tsv"));
const members = parseTsv(rd("docs/metrics/member-outcomes.tsv"));
const verdicts = parseTierOutcomes(rd("docs/metrics/tier-outcomes.tsv"));
const prior = JSON.parse(rd("plugin/scripts/router-table.json"));
const guardRaw = JSON.parse(readFileSync(new URL("./stratum-split-guard.json", import.meta.url), "utf8"));
const guard = T.readGuard(guardRaw);
console.log("features rows", features.length, "constants", T.HEAVY_BRIEF_CHARS, T.HEAVY_CRITERIA);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const show = (name, rows) => {
  const bc = rows.filter(r => r.brief_chars !== "").map(r => +r.brief_chars), cr = rows.filter(r => r.criteria !== "").map(r => +r.criteria);
  console.log(`\n[${name}] rows=${rows.length} brief_chars n=${bc.length}:`, [0, .1, .25, .5, .75, .9, 1].map(p => `p${p*100}=${q(bc, p)}`).join(" "), "| criteria n=" + cr.length + ":", [0, .1, .25, .5, .75, .9, 1].map(p => `p${p*100}=${q(cr, p)}`).join(" "));
  console.log("  share brief>3483:", (bc.filter(x=>x>3483).length/bc.length).toFixed(3), "share criteria>5:", (cr.filter(x=>x>5).length/cr.length).toFixed(3), "share either:", (rows.filter(r=>r.brief_chars!==""&&r.criteria!==""&&(+r.brief_chars>3483||+r.criteria>5)).length/rows.length).toFixed(3));
  const c = {}; for (const r of rows) { const s = T.ruleStratum(r); c[s] = (c[s] ?? 0) + 1; }
  console.log("  ruleStratum:", JSON.stringify(c), Object.fromEntries(Object.entries(c).map(([k,v])=>[k,(v/rows.length).toFixed(3)])));
};
show("all feature rows", features);
const slices = features.filter(r => r.parent);
console.log("Slice rows (parent non-blank):", slices.length);
show("non-Slice rows", features.filter(r => !r.parent));
show("Slice rows", slices);
const sliceBy = {}; for (const r of slices) sliceBy[T.ruleStratum({...r, parent: ""})] = (sliceBy[T.ruleStratum({...r, parent: ""})] ?? 0) + 1;
console.log("Slices' would-be stratum without parent:", JSON.stringify(sliceBy));
console.log("blank-metric rows:", features.filter(r=>r.brief_chars===""||r.criteria==="").length, "of which parent:", features.filter(r=>(r.brief_chars===""||r.criteria==="")&&r.parent).length);
console.log("sizing_src:", JSON.stringify(features.reduce((a,r)=>(a[r.sizing_src]=(a[r.sizing_src]??0)+1,a),{})));
console.log("rows with exploration_draw blank:", features.filter(r=>r.exploration_draw==="").length);

const fit = T.fitTable({ prior, features, members, verdicts, guard, commit: null });
console.log("\nFIT stage", fit.stage, "cells", fit.cells.join(","), "n_rows", fit.n_rows, "burn_in", fit.burn_in, "tripped", fit.guard.tripped.join(","));
console.log("rows", JSON.stringify(fit.rows));
console.log("classifier", JSON.stringify(fit.classifier));
console.log("\n* vs guard cells[]:");
for (const c of guardRaw.cells) { const e = fit.estimates["*"][c.cell]; console.log(` ${c.cell} guard n=${c.n} mean_usd=${c.mean_usd} fail=${c.fail_rate} | fit* n=${e?.n} merged=${e?.merged} usd=${e?.usd_per_merged} fail=${e?.fail_rate} gen=${e?.generation}`); }
console.log("\nPer stratum per cell (newest generation): n / merged / failed / claims / $/merged / min/merged / fail_rate");
for (const s of Object.keys(fit.estimates)) for (const [c, e] of Object.entries(fit.estimates[s])) console.log(` ${s.padEnd(8)} ${c.padEnd(12)} n=${e.n} merged=${e.merged} failed=${e.failed}/${e.claims} usd=${e.usd_per_merged} min=${e.minutes_per_merged} fail=${e.fail_rate}`);
console.log("\nreasons per objective/stratum:");
for (const o of ["cost","speed"]) for (const [s, r] of Object.entries(fit.reasons[o])) console.log(` ${o} ${s}: cell=${r.cell} reason=${r.reason} cells=${JSON.stringify(Object.fromEntries(Object.entries(r.cells).map(([c,v])=>[c,v.verdict])))}`);
console.log("\nstratum row differs from *?");
for (const o of ["cost","speed"]) for (const s of Object.keys(fit.rows[o])) if (s!=="*") console.log(` ${o} ${s}: ${fit.rows[o][s]} vs * ${fit.rows[o]["*"]} differs=${fit.rows[o][s]!==fit.rows[o]["*"]}`);
console.log(" strata with a cost row:", Object.keys(fit.rows.cost).join(","), "| speed:", Object.keys(fit.rows.speed).join(","));

// ---- extras ----
console.log("\n== pairs (candidate-vs-base bootstrap range) per stratum, cost");
for (const [s, r] of Object.entries(fit.reasons.cost)) for (const [c, v] of Object.entries(r.cells)) console.log(` ${s} ${c}: verdict=${v.verdict} range=${JSON.stringify(v.range)} bar=${v.bar} under_floor=${v.under_floor}`);
console.log("== light vs heavy $/merged ratio per cell:");
for (const c of ["slow-high","task-high","smol-high"]) { const l = fit.estimates.light[c], h = fit.estimates.heavy[c]; console.log(` ${c}: light ${l.usd_per_merged} heavy ${h.usd_per_merged} ratio light/heavy=${(l.usd_per_merged/h.usd_per_merged).toFixed(3)}; fail light ${l.fail_rate} heavy ${h.fail_rate}; task-high/slow-high light=${(fit.estimates.light["task-high"].usd_per_merged/fit.estimates.light["slow-high"].usd_per_merged).toFixed(3)} heavy=${(fit.estimates.heavy["task-high"].usd_per_merged/fit.estimates.heavy["slow-high"].usd_per_merged).toFixed(3)} *=${(fit.estimates["*"]["task-high"].usd_per_merged/fit.estimates["*"]["slow-high"].usd_per_merged).toFixed(3)}`); }

// threshold sensitivity: same fit pipeline (attribute -> tally), stratum rule swapped. [not the router's constants]
const { attribute, tally, generations } = await imp("pull-attribution.mjs");
const all0 = attribute({ features, members, tiers: verdicts, windowStart: guard.window_start || null, stratum: T.ruleStratum });
const order = generations(all0);
const med = q(features.map(r => +r.brief_chars), .5);
const alt = (r) => { const base = T.ruleStratum({ ...r, parent: "" }); if (r.brief_chars === "" || r.criteria === "") return "unknown"; if (r.parent) return "heavy"; return (+r.brief_chars > med || +r.criteria > 5) ? "heavy" : "light"; };
console.log(`\n== sensitivity: brief threshold = this repo's own median of all feature rows (${med}) instead of 3483, criteria 5, Slice heavy`);
const units = attribute({ features, members, tiers: verdicts, windowStart: guard.window_start || null, stratum: alt }).filter(u => u.pull.exploration_draw !== "" || u.pull.sizing_src === "rule");
for (const s of ["light","heavy"]) { for (const t of tally(units.filter(u => u.stratum === s), order)) console.log(` ${s} ${t.cell} n=${t.n} merged=${t.merged} usd/merged=${t.merged ? (t.spend/t.merged).toFixed(2) : null}`); }
const cnt = {}; for (const r of features) { const s = alt(r); cnt[s] = (cnt[s]||0)+1; } console.log(" shares:", JSON.stringify(cnt));

// route demonstrations
const mkIssue = (chars, crit) => ({ body: "x".repeat(chars) + "\n" + Array.from({length: crit}, () => "- [ ] c").join("\n"), comments: [], labels: [], createdAt: "2026-10-01T00:00:00Z", title: "t" });
const fitTbl = { ...fit, guard: fit.guard };
const g = guard; // tripped: smol-high
console.log("\n== route demos (guard from pr-cost; objective cost)");
const demo = (label, table, issue, implRow, arm = "A") => { const r = T.route({ session: "2026-11-01T00-00-00-000Z_aaaaaaaa-0000-0000-0000-000000000000", ticket: 5000 + implRow, arm, implRow, issue, guard: g, table, objective: "cost" }); console.log(` ${label}: stratum-line=${r.line.slice(0,160)} | policy=${r.row.policy_cell} chosen=${r.row.chosen_cell} draw=${r.row.exploration_draw}`); };
for (const [name, iss] of [["light(1000ch,0crit)", mkIssue(1000,0)], ["heavy(4000ch)", mkIssue(4000,0)]]) demo(`fit table burn_in=true ${name} implRow=7`, fitTbl, iss, 7);
const post = { ...fit, burn_in: false, rows: { cost: { "*": "slow-high", light: "task-high", heavy: "slow-high" }, speed: { "*": "slow-high", light: "task-high", heavy: "slow-high" } } };
const postB = { ...post };
for (const [name, iss] of [["light", mkIssue(1000,0)], ["heavy", mkIssue(4000,0)]]) { demo(`hypothetical burn_in=false rows{light:task-high,heavy:slow-high} ${name} implRow=7 (non-exploring)`, post, iss, 7); }
const burnWithRows = { ...post, burn_in: true };
for (const [name, iss] of [["light", mkIssue(1000,0)], ["heavy", mkIssue(4000,0)]]) demo(`same rows, burn_in=true ${name} implRow=7`, burnWithRows, iss, 7);
console.log("rowDispatch burn_in=true light:", JSON.stringify(T.rowDispatch({ table: burnWithRows, guard: g, objective: "cost", stratum: "light" })));
console.log("rowDispatch burn_in=false light:", JSON.stringify(T.rowDispatch({ table: post, guard: g, objective: "cost", stratum: "light" })));
console.log("rowDispatch burn_in=false heavy:", JSON.stringify(T.rowDispatch({ table: post, guard: g, objective: "cost", stratum: "heavy" })));
console.log("rowDispatch burn_in=false unknown (no row -> *):", JSON.stringify(T.rowDispatch({ table: post, guard: g, objective: "cost", stratum: "unknown" })));
console.log("bArmLive(shipped table cost):", T.bArmLive(prior, "cost"), " bArmLive(fit, cost) with classifier.b null:", T.bArmLive(fit, "cost"), " with b=haiku & fit rows:", T.bArmLive({ ...fit, classifier: { b: "haiku", tau: null } }, "cost"), "(fit rows all task-high != slow-high)");
