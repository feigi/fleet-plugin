#!/usr/bin/env node
// Derivation script for issue #4120 (map #4118): which role x effort Cells can
// exist, what each costs, and what effort measurably does per Pull.
//
//   node docs/research/cell-grid-derive.mjs [--no-omp]
//
// Run from a checkout: it imports the Router's own modules beside it.
//   A. LIVE omp reads (this machine's `modelRoles` and model catalog) through
//      tier-roles.mjs's own readers, and the role x level grid built from them,
//      with each Cell's neighbours. Needs `omp` on PATH; --no-omp skips A and
//      the catalog half of B.
//   B. Price: docs/metrics/pricing.json beside the catalog's own `cost`.
//   C. Effort effect: docs/metrics/member-outcomes.tsv, pre-cutover
//      implementer Pulls at `high` vs `xhigh` on one model, read through
//      member-outcomes.mjs's parseTsv and ledger-grammar.mjs's parseMember.
// C and the pricing.json half of B reproduce from the committed files alone;
// A and the catalog half of B read the operator's live omp.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapDiffCI } from "../../plugin/scripts/pull-attribution.mjs";
import { parseTsv } from "../../plugin/scripts/member-outcomes.mjs";
import { CELL, POLICY_CELL, parseMember } from "../../plugin/scripts/ledger-grammar.mjs";
import { catalogEntry, readOmpConfigValue, readOmpModelCatalog, resolveRole, stripLevel } from "../../plugin/scripts/tier-roles.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROLES = ["slow", "task", "smol"]; // the order tier-roles.mjs's ROLE_ORDER prints them in
// CELL's own alternation, so a level added to the grammar appears here.
const LEVELS = /\(([a-z|]+)\)\$\/$/.exec(CELL.toString())[1].split("|");
const noOmp = process.argv.includes("--no-omp");
const out = (s = "") => console.log(s);
const fmt = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? "-" : Number(n).toFixed(d));

// ---------------------------------------------------------------- A + B
const pricing = JSON.parse(readFileSync(join(REPO, "docs/metrics/pricing.json"), "utf8")).models;
let modelRoles = null;
let catalog = null;
if (!noOmp) {
  modelRoles = readOmpConfigValue("modelRoles");
  catalog = readOmpModelCatalog();
}

out("## A. modelRoles and the level grid (live omp)");
if (modelRoles === null) out("skipped (--no-omp)");
else {
  out("role\tmodelRoles entry\tresolved model\tcatalog thinking");
  const targets = {};
  for (const role of ROLES) {
    const model = resolveRole(role, modelRoles);
    const entry = model === null ? null : catalogEntry(model, catalog);
    targets[role] = { model, efforts: entry?.thinking ?? [] };
    out(`${role}\t${modelRoles[role] ?? "-"}\t${model}\t${(entry?.thinking ?? ["(not listed)"]).join(",")}`);
  }
  out();
  out(`grid: rows = role, columns = CELL's levels (${LEVELS.join(" ")}); R = the catalog lists the level, C = omp would clamp it`);
  out(["role", ...LEVELS].join("\t"));
  for (const role of ROLES) out([role, ...LEVELS.map((l) => (targets[role].efforts.includes(l) ? "R" : "C"))].join("\t"));
  out();
  // Neighbours. Level ladder: the role's own catalog `thinking` order. Role ladder: by output price per token
  // (catalog cost.output), cheapest first.
  const price = (role) => catalog.models.find((m) => m.selector === targets[role].model)?.cost?.output ?? null;
  const byPrice = [...ROLES].sort((a, b) => price(a) - price(b));
  out(`role ladder by catalog output $/Mtok, cheapest first: ${byPrice.map((r) => `${r}(${price(r)})`).join(" < ")}`);
  const existing = ["slow-high", "task-high", "smol-high", "slow-medium", "task-max"];
  out();
  out("cell\tlevel-up\tlevel-down\trole-up(dearer) at same level\trole-down(cheaper) at same level");
  const runs = (role, level) => targets[role].efforts.includes(level);
  for (const cell of existing) {
    const [role, level] = cell.split("-");
    const ladder = targets[role].efforts;
    const i = ladder.indexOf(level);
    const tag = (r, l) => (l === undefined ? "none" : `${r}-${l}${runs(r, l) ? "" : " [clamped]"}`);
    const up = tag(role, ladder[i + 1]);
    const down = tag(role, ladder[i - 1]);
    const k = byPrice.indexOf(role);
    const dearer = k + 1 < byPrice.length ? tag(byPrice[k + 1], level) : "none";
    const cheaper = k > 0 ? tag(byPrice[k - 1], level) : "none";
    out(`${cell}${cell === POLICY_CELL ? " (policy)" : ""}\t${up}\t${down}\t${dearer}\t${cheaper}`);
  }
}
out();
out("## B. price (USD per million tokens)");
out("model\tin\tout\tcache_read\tcache_write_1h\tsource");
for (const [m, p] of Object.entries(pricing)) out(`${m}\t${p.input}\t${p.output}\t${p.cache_read}\t${p.cache_write_1h}\tdocs/metrics/pricing.json`);
if (catalog !== null) {
  for (const role of ROLES) {
    const sel = resolveRole(role, modelRoles);
    const c = catalog.models.find((m) => m.selector === sel)?.cost;
    out(`${stripLevel(sel).replace(/^[^/]+\//, "")}\t${c?.input}\t${c?.output}\t${c?.cacheRead}\t${c?.cacheWrite}\tomp models --json (cacheWrite = the catalog's one figure)`);
  }
}

// ---------------------------------------------------------------- C
out();
out("## C. effort effect, pre-cutover implementer Pulls (member-outcomes.tsv)");
const rows = parseTsv(readFileSync(join(REPO, "docs/metrics/member-outcomes.tsv"), "utf8"));
// A Pull is (session, impl number): its attempts (`impl-N`, `impl-N-b`, ...) are summed.
const pullsFor = (harness) => {
  const pulls = new Map();
  for (const r of rows) {
    if (r.subagentType !== "fleet-implementer" && r.subagentType !== "fleet-implementer-alt") continue;
    if (r.harness !== harness) continue;
    const m = parseMember(r.member);
    if (m === null || m.family !== "impl") continue;
    const key = `${r.session}/${m.number}`;
    const p = pulls.get(key) ?? { type: r.subagentType, model: r.model, effort: r.effort, date: r.run_date, out: 0, turns: 0, wall: 0, cost: 0, mixed: false };
    if (p.model !== r.model || p.effort !== r.effort) p.mixed = true;
    p.out += Number(r.tokensOut);
    p.turns += Number(r.turns);
    p.wall += Number(r.wallS);
    p.cost += r.cost === "" ? NaN : Number(r.cost); // the claude harness records no $
    p.date = r.run_date < p.date ? r.run_date : p.date;
    pulls.set(key, p);
  }
  return [...pulls.values()].filter((p) => !p.mixed);
};
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { mean: xs.reduce((a, b) => a + b, 0) / xs.length, med: q(0.5) };
};
const line = (label, ps) => {
  const f = (sel) => stats(ps.map(sel));
  const o = f((p) => p.out), t = f((p) => p.turns), w = f((p) => p.wall), c = f((p) => p.cost);
  const dates = ps.map((p) => p.date).sort();
  out([label, ps.length, `${dates[0]}..${dates.at(-1)}`, `${fmt(o.mean, 0)}/${fmt(o.med, 0)}`, `${fmt(t.mean, 1)}/${fmt(t.med, 0)}`, `${fmt(w.mean, 0)}/${fmt(w.med, 0)}`, `${fmt(c.mean)}/${fmt(c.med)}`].join("\t"));
};
// Router's own bootstrap (pull-attribution.mjs bootstrapDiffCI, 2000 resamples, seed 1) over per-Pull units:
// every unit counts as merged:1, so the figure is the mean per Pull, not per merged PR. Ends are rounded to 2 places.
const ci = (xh, hi, sel) => bootstrapDiffCI(xh.map((p) => ({ value: sel(p), merged: 1 })), hi.map((p) => ({ value: sel(p), merged: 1 })));
const range = (ps) => { const d = ps.map((p) => p.date).sort(); return [d[0], d.at(-1)]; };
for (const harness of ["omp", "claude"]) {
  out();
  out(`### harness ${harness}${harness === "claude" ? " (no dispatch_model, tokens_in or $ of record: tokens_out, turns, wall_s only)" : ""}`);
  const pulls = pullsFor(harness);
  const groups = new Map();
  for (const p of pulls) (groups.get(`${p.model}\t${p.type}\t${p.effort}`) ?? groups.set(`${p.model}\t${p.type}\t${p.effort}`, []).get(`${p.model}\t${p.type}\t${p.effort}`)).push(p);
  out("cells are mean/median per Pull; one Pull = one session's impl-N with its retries summed");
  out("model\tsubagent_type\teffort\tn Pulls\trun_date span\ttokens_out\tturns\twall_s\tcost USD");
  for (const k of [...groups.keys()].sort()) line(k, groups.get(k));
  out();
  out("same model, both efforts pooled over subagent_type: all dates, then only the dates both efforts share (the era control); xhigh minus high, bootstrap 95% range");
  out("model\tsubagent_type\teffort\tn Pulls\trun_date span\ttokens_out\tturns\twall_s\tcost USD");
  for (const model of [...new Set(pulls.map((p) => p.model))].sort()) {
    const hi = pulls.filter((p) => p.model === model && p.effort === "high"), xh = pulls.filter((p) => p.model === model && p.effort === "xhigh");
    if (!hi.length || !xh.length) continue;
    for (const [scope, from, to] of [["all dates", "0000", "9999"], ["shared dates", [range(hi)[0], range(xh)[0]].sort().at(-1), [range(hi)[1], range(xh)[1]].sort()[0]]]) {
      if (from > to) { out(`${model}\t${scope}\t(none shared: high ${range(hi).join("..")}, xhigh ${range(xh).join("..")})`); continue; }
      const h = hi.filter((p) => p.date >= from && p.date <= to), x = xh.filter((p) => p.date >= from && p.date <= to);
      if (!h.length || !x.length) continue;
      line(`${model}\t${scope}\thigh`, h);
      line(`${model}\t${scope}\txhigh`, x);
      const d = (sel) => { const r = ci(x, h, sel); return r === null ? "-" : `[${r[0]}, ${r[1]}]`; };
      out(`${model}\t${scope}\txhigh-high\t\t\t${d((p) => p.out)}\t${d((p) => p.turns)}\t${d((p) => p.wall)}\t${harness === "omp" ? d((p) => p.cost) : "-"}`);
    }
  }
}

out();
out("## C2. post-cutover implementer Pulls by Cell (subagent_type fleet-implementer-<cell>)");
const cellPulls = new Map(); // `cell\tmodel\teffort` -> Map(session/number -> { out, cost, date })
for (const r of rows) {
  const m = /^fleet-implementer-(.+)$/.exec(r.subagentType);
  if (!m || !CELL.test(m[1]) || r.harness !== "omp") continue;
  const pm = parseMember(r.member);
  if (pm === null || pm.family !== "impl") continue;
  const k = `${m[1]}\t${r.model}\t${r.effort}`;
  const g = cellPulls.get(k) ?? cellPulls.set(k, new Map()).get(k);
  const p = g.get(`${r.session}/${pm.number}`) ?? { out: 0, cost: 0, date: r.run_date };
  p.out += Number(r.tokensOut);
  p.cost += Number(r.cost);
  p.date = r.run_date < p.date ? r.run_date : p.date;
  g.set(`${r.session}/${pm.number}`, p);
}
out("cell\tmodel\teffort\tn Pulls\trun_date span\ttokens_out mean\tcost USD mean");
for (const k of [...cellPulls.keys()].sort()) {
  const ps = [...cellPulls.get(k).values()];
  const [d0, d1] = range(ps);
  out(`${k}\t${ps.length}\t${d0}..${d1}\t${fmt(stats(ps.map((p) => p.out)).mean, 0)}\t${fmt(stats(ps.map((p) => p.cost)).mean)}`);
}
for (const c of ["slow-medium", "task-max"]) if (![...cellPulls.keys()].some((k) => k.startsWith(`${c}\t`))) out(`${c}\t(no rows)`);
