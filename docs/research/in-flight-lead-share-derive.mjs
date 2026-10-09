#!/usr/bin/env node
// Lead-time (implementer phase) sensitivity of the In-flight bound: shifts each
// ticket's in-flight interval to [created − L, merged] and tabulates the share of
// Pulls a bound B would hold, plus the merge gate's pace and Little's-law level.
// usage: node in-flight-lead-share-derive.mjs BASE_JSON [--cache DIR] [--out FILE.json]
// Reads the baseline derive script's --json rows (number, created, merged, depth, cycleH) and the
// cached issue-events pages (for ready-to-merge label timing). No network.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const baseJson = args[0];
const cacheDir = (args.includes("--cache") ? args[args.indexOf("--cache") + 1] : "/tmp/inflight-cache") + "/feigi__fleet-plugin";
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const MIN = 60_000, H = 3_600_000;
const LS = [0, 10, 19.3, 30];
const BS = [4, 5, 6, 7, 8, 9, 10, 12];
const BURST = ["2026-10-03", "2026-10-04"];

const base = JSON.parse(fs.readFileSync(baseJson, "utf8"));
const prs = base.rows.map((r) => ({ n: r.number, created: Date.parse(r.created), merged: Date.parse(r.merged), depth0: r.depth }));
const day = (t) => new Date(t).toISOString().slice(0, 10);

// ---- stats (linear interpolation, same as the baseline's pct())
const sorted = (xs) => xs.slice().sort((a, b) => a - b);
function pct(xs, p) { const s = sorted(xs); if (!s.length) return NaN; const k = (s.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, s.length - 1); return s[f] + (s[c] - s[f]) * (k - f); }
const median = (xs) => pct(xs, 0.5);
const mh = (ms) => (Number.isNaN(ms) ? "—" : (ms / H).toFixed(2)); // hours
const mm = (ms) => (Number.isNaN(ms) ? "—" : (ms / MIN).toFixed(0)); // minutes

// ---- in-flight at Pull moments + time sweep for interval set {start_i = created_i - L, end_i = merged_i}
function model(L, subset) {
  const lead = L * MIN;
  const iv = prs.map((p) => ({ ...p, start: p.created - lead, end: p.merged }));
  // count at Pull moment t_i: others j with start_j <= t_i < end_j (same-instant: merges first; arrival tie -> lower number first, as baseline)
  for (const a of iv) {
    let c = 0;
    for (const b of iv) {
      if (b === a) continue;
      if ((b.start < a.start || (b.start === a.start && b.n < a.n)) && b.end > a.start) c++;
    }
    a.inflight = c;
  }
  // time sweep
  const ev = [];
  for (const it of iv) { ev.push({ t: it.start, d: 1, n: it.n }); ev.push({ t: it.end, d: -1, n: it.n }); }
  ev.sort((x, y) => x.t - y.t || x.d - y.d || x.n - y.n);
  const segs = []; // [from,to,depth]
  let d = 0, prev = ev[0].t, max = 0;
  for (const e of ev) { if (e.t > prev) segs.push([prev, e.t, d]); d += e.d; prev = e.t; if (d > max) max = d; }
  const wall = ev[ev.length - 1].t - ev[0].t;
  return { L, iv, segs, wall, max };
}

function timeStats(m, B) {
  let area = 0, open = 0, atLeast = 0;
  for (const [a, b, d] of m.segs) { const dt = b - a; area += d * dt; if (d >= 1) open += dt; if (d >= B) atLeast += dt; }
  return { meanWall: area / m.wall, meanOpen: area / open, shareWall: atLeast / m.wall, shareOpen: atLeast / open, hoursAtLeast: atLeast / H, wallH: m.wall / H, openH: open / H };
}

function dayTable(rows, bound, daysAll) {
  const per = new Map(daysAll.map((d) => [d, 0]));
  for (const r of rows) if (r.inflight >= bound) per.set(day(r.start), (per.get(day(r.start)) ?? 0) + 1);
  return per;
}

function bTable(m, excludeDays = []) {
  const keep = (r) => !excludeDays.includes(day(r.start));
  const rows = m.iv.filter(keep);
  const daysAll = [...new Set(rows.map((r) => day(r.start)))].sort();
  const out = [];
  for (const B of BS) {
    const held = rows.filter((r) => r.inflight >= B), rest = rows.filter((r) => r.inflight < B);
    const per = dayTable(rows, B, daysAll);
    const counts = [...per.values()];
    const withHeld = counts.filter((c) => c > 0);
    const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).filter(([, c]) => c > 0).map(([d, c]) => `${d.slice(5)}:${c}`);
    const cyc = (rs) => rs.map((r) => r.end - r.created);
    out.push({
      B, n: rows.length, heldN: held.length, heldPct: (100 * held.length) / rows.length,
      days: daysAll.length, daysWithHeld: withHeld.length, perDayMeanAllDays: held.length / daysAll.length,
      perDayMedianAllDays: median(counts), perDayMax: Math.max(...counts), top: top.join(" "),
      heldMed: median(cyc(held)), heldP90: pct(cyc(held), 0.9), restN: rest.length, restMed: median(cyc(rest)), restP90: pct(cyc(rest), 0.9),
      ...(excludeDays.length ? {} : timeStats(m, B)),
    });
  }
  return out;
}

const fmt = (x, d = 1) => (Number.isNaN(x) ? "—" : x.toFixed(d));
const results = { source: baseJson, population: { n: prs.length, first: base.population.first, last: base.population.last, createdFrom: base.population.createdFrom, createdTo: base.population.createdTo }, byL: {}, sens: {} };
const lines = [];
const P = (s = "") => lines.push(s);

P(`# lead-time analysis — source ${baseJson}; population #${base.population.first}–#${base.population.last} (n=${prs.length}), created ${base.population.createdFrom} → ${base.population.createdTo}`);
// sanity: L=0 must reproduce baseline depth at arrival
{
  const m0 = model(0);
  const byN = new Map(m0.iv.map((r) => [r.n, r.inflight]));
  const bad = prs.filter((p) => byN.get(p.n) !== p.depth0);
  P(`L=0 depth-at-arrival reproduction vs baseline --json: ${prs.length - bad.length}/${prs.length} identical`);
  results.l0Reproduction = { identical: prs.length - bad.length, total: prs.length };
}
P();

for (const L of LS) {
  const m = model(L);
  const tab = bTable(m);
  const allCounts = m.iv.map((r) => r.inflight);
  const ts = timeStats(m, 99);
  results.byL[L] = { max: m.max, meanWall: ts.meanWall, meanOpen: ts.meanOpen, wallH: ts.wallH, openH: ts.openH, inflightAtPull: { median: median(allCounts), p75: pct(allCounts, 0.75), p90: pct(allCounts, 0.9), max: Math.max(...allCounts), mean: allCounts.reduce((a, b) => a + b, 0) / allCounts.length }, table: tab };
  P(`## L = ${L} min — Pull = created − ${L} min; in-flight interval [created − L, merged]`);
  P(`In-flight at Pull (others): median ${median(allCounts)} / p75 ${pct(allCounts, 0.75)} / p90 ${pct(allCounts, 0.9)} / max ${Math.max(...allCounts)}, mean ${fmt(allCounts.reduce((a, b) => a + b, 0) / allCounts.length, 2)}. Time-weighted mean: ${fmt(ts.meanWall, 2)} over wall ${fmt(ts.wallH, 1)} h, ${fmt(ts.meanOpen, 2)} while ≥1 in flight (${fmt(ts.openH, 1)} h). Max in flight ${m.max}.`);
  P();
  P(`| B | held share % | held n/${prs.length} | held per day: mean over ${tab[0].days} days / median / max (days with ≥1 held) [top days] | cycle h median / p90 — held | cycle h median / p90 — not held (n) | time share ≥B: of wall % / of ≥1-in-flight time % (h) |`);
  P(`|---|---|---|---|---|---|---|`);
  for (const t of tab) {
    P(`| ${t.B} | ${fmt(t.heldPct)} | ${t.heldN} | ${fmt(t.perDayMeanAllDays)} / ${t.perDayMedianAllDays} / ${t.perDayMax} (${t.daysWithHeld}) [${t.top}] | ${mh(t.heldMed)} / ${mh(t.heldP90)} | ${mh(t.restMed)} / ${mh(t.restP90)} (${t.restN}) | ${fmt(100 * t.shareWall)} / ${fmt(100 * t.shareOpen)} (${fmt(t.hoursAtLeast)}) |`);
  }
  P();
}

// ---- step 4: exclude burst days (by the day of the Pull moment), all L (L=19.3 is the requested one)
for (const L of LS) {
  const m = model(L);
  const tab = bTable(m, BURST);
  results.sens[L] = tab;
  if (L !== 19.3) continue;
  P(`## Sensitivity (step 4), L = ${L} min — Pulls whose Pull day (UTC) is 2026-10-03 or 2026-10-04 removed from the *counted* Pulls; the in-flight counts still include those days' PRs as other tickets (their interval is real); n = ${tab[0].n}`);
  P();
  P(`| B | held share % | held n/${tab[0].n} | held per day: mean over ${tab[0].days} days / median / max (days with ≥1 held) [top days] | cycle h median / p90 — held | cycle h median / p90 — not held (n) |`);
  P(`|---|---|---|---|---|---|`);
  for (const t of tab) P(`| ${t.B} | ${fmt(t.heldPct)} | ${t.heldN} | ${fmt(t.perDayMeanAllDays)} / ${t.perDayMedianAllDays} / ${t.perDayMax} (${t.daysWithHeld}) [${t.top}] | ${mh(t.heldMed)} / ${mh(t.heldP90)} | ${mh(t.restMed)} / ${mh(t.restP90)} (${t.restN}) |`);
  P();
}
// strict variant of step 4: also drop burst-day PRs from the population entirely (they cannot be "other tickets in flight")
{
  const L = 19.3;
  const keepN = new Set(prs.filter((p) => !BURST.includes(day(p.created - L * MIN)) && !BURST.includes(day(p.created)) && !BURST.includes(day(p.merged))).map((p) => p.n));
  const saved = prs.slice();
  prs.length = 0; saved.filter((p) => keepN.has(p.n)).forEach((p) => prs.push(p));
  const m = model(L);
  const tab = bTable(m);
  results.sensStrict = tab;
  P(`## Sensitivity (step 4, strict variant), L = ${L} min — burst-day PRs removed from the population entirely (any PR whose Pull, creation or merge falls on 10-03/10-04), so burst traffic is also absent from the in-flight counts; n = ${prs.length}`);
  P();
  P(`| B | held share % | held n/${prs.length} | held per day mean/median/max (days with ≥1 held) | cycle h median / p90 — held | cycle h median / p90 — not held (n) | time share ≥B: of wall % / of ≥1-in-flight % |`);
  P(`|---|---|---|---|---|---|---|`);
  for (const t of tab) P(`| ${t.B} | ${fmt(t.heldPct)} | ${t.heldN} | ${fmt(t.perDayMeanAllDays)} / ${t.perDayMedianAllDays} / ${t.perDayMax} (${t.daysWithHeld}) | ${mh(t.heldMed)} / ${mh(t.heldP90)} | ${mh(t.restMed)} / ${mh(t.restP90)} (${t.restN}) | ${fmt(100 * t.shareWall)} / ${fmt(100 * t.shareOpen)} |`);
  P();
  prs.length = 0; saved.forEach((p) => prs.push(p));
}

// ---- step 3: merge-gate capacity
function readEvents(n) {
  const evs = [];
  for (let pg = 1; ; pg++) {
    const f = path.join(cacheDir, `repos_feigi_fleet-plugin_issues_${n}_events_per_page_100_page_${pg}.json`);
    if (!fs.existsSync(f)) break;
    const body = JSON.parse(fs.readFileSync(f, "utf8"));
    const arr = body.data;
    evs.push(...arr);
    if (arr.length < 100) break;
  }
  return evs;
}
const RTM = "ready-to-merge";
let noEvents = 0;
for (const p of prs) {
  const ev = readEvents(p.n);
  if (!ev.length) noEvents++;
  const labeled = ev.filter((e) => e.event === "labeled" && e.label && e.label.name === RTM).map((e) => Date.parse(e.created_at)).sort((a, b) => a - b);
  const pre = labeled.filter((t) => t <= p.merged);
  p.label1 = pre.length ? pre[0] : null;
}
const byMerge = prs.slice().sort((a, b) => a.merged - b.merged || a.n - b.n);
const gaps = []; // {gap, busyLabel, busy30}
for (let i = 1; i < byMerge.length; i++) {
  const a = byMerge[i - 1], b = byMerge[i];
  const gap = b.merged - a.merged;
  // label-waiting definition: at the instant of the earlier merge, the later-merging PR was already labelled (first label <= a.merged) and unmerged -> queue was non-empty across the gap
  const waiting = byMerge.some((q, k) => k >= i && q.label1 !== null && q.label1 <= a.merged);
  gaps.push({ gap, waiting, within30: gap < 30 * MIN });
}
const statGaps = (xs) => ({ n: xs.length, medianMin: median(xs) / MIN, meanMin: xs.reduce((a, b) => a + b, 0) / xs.length / MIN, p25Min: pct(xs, 0.25) / MIN, p75Min: pct(xs, 0.75) / MIN });
const gW = gaps.filter((g) => g.waiting).map((g) => g.gap);
const g30 = gaps.filter((g) => g.within30).map((g) => g.gap);
const gBoth = gaps.filter((g) => g.waiting && g.within30).map((g) => g.gap);
const gAll = gaps.map((g) => g.gap);
const W0rows = prs.filter((p) => p.depth0 <= 2);
const W0 = median(W0rows.map((p) => p.merged - p.created));
const W0_01 = median(prs.filter((p) => p.depth0 <= 1).map((p) => p.merged - p.created));
const W0_0 = median(prs.filter((p) => p.depth0 === 0).map((p) => p.merged - p.created));
const defs = {
  waiting: { label: "label-waiting: gap after merge i is busy if some PR merging after i already carried its first ready-to-merge label at merge i's instant", s: statGaps(gW) },
  within30: { label: "consecutive merges < 30 min apart", s: statGaps(g30) },
  waitingAnd30: { label: "both of the above", s: statGaps(gBoth) },
  allGaps: { label: "all inter-merge gaps", s: statGaps(gAll) },
};
P(`## Step 3 — merge-gate capacity`);
P(`PRs with no ready-to-merge label event in cache: ${noEvents}; PRs with no label before merge: ${prs.filter((p) => p.label1 === null).length}. Merges ${byMerge.length}; gaps ${gaps.length}.`);
P();
P(`| gap definition | n gaps | median gap min | μ = 60/median (merges/h) | mean gap min | μ=60/mean | p25–p75 min |`);
P(`|---|---|---|---|---|---|---|`);
results.step3 = { W0min: W0 / MIN, W0n: W0rows.length, W0_depth0to1min: W0_01 / MIN, W0_depth0min: W0_0 / MIN, defs: {} };
for (const [k, d] of Object.entries(defs)) {
  const s = d.s;
  P(`| ${d.label} | ${s.n} | ${fmt(s.medianMin, 2)} | ${fmt(60 / s.medianMin, 2)} | ${fmt(s.meanMin, 2)} | ${fmt(60 / s.meanMin, 2)} | ${fmt(s.p25Min, 1)}–${fmt(s.p75Min, 1)} |`);
  const mu = 60 / s.medianMin;
  results.step3.defs[k] = { ...s, muPerH: mu, muPerH_mean: 60 / s.meanMin, muW0: (mu * W0) / H, muW0plusImpl: (mu * (W0 + 19.3 * MIN)) / H };
}
P();
P(`W0 = median created→merged, PRs arriving at open-PR depth 0–2 (baseline depth, L=0): n=${W0rows.length}, ${fmt(W0 / MIN, 1)} min (${mh(W0)} h). Depth 0–1: ${fmt(W0_01 / MIN, 1)} min; depth 0: ${fmt(W0_0 / MIN, 1)} min (n=${prs.filter((p) => p.depth0 === 0).length}).`);
P();
P(`| gap definition | μ /h | μ·W0 | μ·(W0 + 19.3 min) |`);
P(`|---|---|---|---|`);
for (const [k, d] of Object.entries(results.step3.defs)) P(`| ${defs[k].label} | ${fmt(d.muPerH, 2)} | ${fmt(d.muW0, 2)} | ${fmt(d.muW0plusImpl, 2)} |`);
P();
// stages-note pace cross-check: per PR, (c)=label1->merged, served = other merges in (label1, merged); pace=(c)/(served+1)
{
  const hasC = prs.filter((p) => p.label1 !== null);
  const pace = hasC.map((p) => { const served = prs.filter((q) => q !== p && q.merged > p.label1 && q.merged < p.merged).length; return (p.merged - p.label1) / (served + 1); });
  const paceMed = median(pace) / MIN;
  results.step3.stagesPace = { n: hasC.length, medianMinPerMerge: paceMed, meanMinPerMerge: pace.reduce((a, b) => a + b, 0) / pace.length / MIN };
  P(`Stages-note pace cross-check (pace = (first ready-to-merge label → merged) / (merges by others in that span + 1); over all ${hasC.length} labelled PRs): median ${fmt(paceMed, 2)} min/merge (μ ${fmt(60 / paceMed, 2)}/h), mean ${fmt(results.step3.stagesPace.meanMinPerMerge, 2)} min/merge.`);
}
P();
console.log(lines.join("\n"));
if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
