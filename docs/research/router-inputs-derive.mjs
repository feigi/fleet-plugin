#!/usr/bin/env node
// Derivation script for issue #4150: which pre-dispatch ticket inputs change
// which Cell wins, and what a grouping on them would gain over one Cell.
//
// Every figure comes from the Router's own modules, imported from this
// checkout (plugin/scripts/): the Fit's Pull set is ticket-router.mjs's
// `fitPulls` (attribute(...) over docs/metrics/*.tsv, window 2026-10-03,
// filtered to exploration_draw !== "" || sizing_src === "rule"); per-Cell
// newest-generation Pulls are `tally(units, generations(all)).pulls`; the
// bootstrap and quality floor are `bootUnit`/`bootstrapDiffCI`/`underFloor`.
// The nine recorded metrics are read from the features rows as recorded
// (what the Router saw at dispatch). The "free" inputs are derived from each
// ticket's issue as `gh issue view` returns it NOW, through the Router's own
// `briefText`/`briefPaths`; issues are cached outside the repo.
//
// node docs/research/router-inputs-derive.mjs [--cache DIR] [--perms N]
//                                              [--cv-null N] [--seed S]
//   --cache DIR   issue-JSON cache (default <os.tmpdir()>/router-inputs-cache).
//                 Refused inside the repository. A missing issue is fetched
//                 with `gh issue view <n> --json number,title,body,labels,
//                 comments,createdAt,updatedAt,state`; a failed fetch exits 1.
//   --perms N     permutations for the grouping-gain null (default 500).
//   --cv-null N   permutations for the cross-validated null (default 100).
//   --seed S      RNG seed for permutations and folds (default 20261101).
// Zero dependencies beyond the repo's own modules; Node >= 18. Stdout is
// markdown.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const S = path.join(ROOT, "plugin/scripts");
const { attribute, generations, tally, parseFeatures, bootUnit, bootstrapDiffCI, underFloor, TRIP_POINTS } = await import(`${S}/pull-attribution.mjs`);
const { parseTsv, isImplementer } = await import(`${S}/member-outcomes.mjs`);
const { parseTierOutcomes } = await import(`${S}/tier-outcomes.mjs`);
const { ruleStratum, MIN_N, issueMetrics } = await import(`${S}/ticket-router.mjs`);
const { drawCell } = await import(`${S}/ledger-grammar.mjs`);
const { briefText, briefPaths } = await import(`${S}/ticket-text.mjs`);

// ------------------------------------------------------------------ flags
const argv = process.argv.slice(2);
const flags = { cache: path.join(os.tmpdir(), "router-inputs-cache"), perms: 500, cvNull: 100, seed: 20261101 };
const die = (m) => { process.stderr.write(`router-inputs-derive: ${m}\n`); process.exit(1); };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = () => (i + 1 < argv.length ? argv[++i] : die(`${a} needs a value`));
  if (a === "--cache") flags.cache = path.resolve(v());
  else if (a === "--perms") flags.perms = Number(v());
  else if (a === "--cv-null") flags.cvNull = Number(v());
  else if (a === "--seed") flags.seed = Number(v());
  else die(`unknown flag ${a}`);
}
if (!(flags.perms >= 200)) die("--perms must be at least 200");
if (!path.relative(ROOT, flags.cache).startsWith("..")) die(`--cache ${flags.cache} is inside the repository`);
fs.mkdirSync(flags.cache, { recursive: true });

// ------------------------------------------------------------------ helpers
const out = [];
const P = (s = "") => out.push(s);
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(1));
const f2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(2));
const sgn2 = (x) => (x === null || Number.isNaN(x) ? "-" : (x >= 0 ? "+" : "") + x.toFixed(2));
const sgn1 = (x) => (x === null || Number.isNaN(x) ? "-" : (x >= 0 ? "+" : "") + x.toFixed(1));
const rng = (c, d = 2) => (c === null ? "n/a" : `[${c[0].toFixed(d)}, ${c[1].toFixed(d)}]`);
const sig = (c) => (c === null ? "" : c[0] > 0 || c[1] < 0 ? " *" : "");
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => sum(xs) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1)); };
const quantile = (sorted, q) => { const k = (sorted.length - 1) * q, f = Math.floor(k), c = Math.min(f + 1, sorted.length - 1); return sorted[f] + (sorted[c] - sorted[f]) * (k - f); };
const sortedNum = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => quantile(sortedNum(xs), 0.5);

function mulberry32(seed) { // same generator as pull-attribution.mjs's, so seeds are comparable
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(n, rand) { // Fisher-Yates permutation of 0..n-1
  const p = Int32Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  return p;
}

/**
 * Bootstrap 95% range of f(per-group ratio of sums). `groups` is an array of
 * arrays of { num, den }; each group is resampled with replacement in order,
 * one iteration after another, the draw order bootstrapDiffCI uses for its two
 * groups, so a two-group `f = (r) => r[0] - r[1]` reproduces it exactly.
 * null when a group is empty or under half the iterations have every group's
 * denominator positive. Ends rounded to `dec` places.
 */
function boot(groups, f, { iters = 2000, seed = 1, dec = 2 } = {}) {
  if (groups.some((g) => g.length === 0)) return null;
  const rand = mulberry32(seed);
  const diffs = [];
  for (let it = 0; it < iters; it++) {
    const r = groups.map((g) => {
      let a = 0, b = 0;
      for (let i = 0; i < g.length; i++) { const x = g[Math.floor(rand() * g.length)]; a += x.num; b += x.den; }
      return b ? a / b : null;
    });
    if (r.every((x) => x !== null)) diffs.push(f(r));
  }
  if (diffs.length < iters / 2) return null;
  diffs.sort((x, y) => x - y);
  const rd = (x) => Number(x.toFixed(dec));
  return [rd(diffs[Math.floor(0.025 * (diffs.length - 1))]), rd(diffs[Math.ceil(0.975 * (diffs.length - 1))])];
}
const ratio = (units) => { const d = sum(units.map((u) => u.den)); return d ? sum(units.map((u) => u.num)) / d : null; };

// ------------------------------------------------------------------ data
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const features = parseFeatures(read("docs/metrics/ticket-features.tsv"));
const members = parseTsv(read("docs/metrics/member-outcomes.tsv"));
const verdicts = parseTierOutcomes(read("docs/metrics/tier-outcomes.tsv"));
const WINDOW = "2026-10-03";
const all = attribute({ features, members, tiers: verdicts, windowStart: WINDOW, stratum: ruleStratum });
const order = generations(all);
const units = all.filter((u) => u.pull.exploration_draw !== "" || u.pull.sizing_src === "rule");
const tallies = tally(units, order);
const gitHead = spawnSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();

const CELLS = ["slow-high", "task-high", "smol-high"];
const NUM = ["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs"];
const KINDS = new Set(["bug", "enhancement", "documentation"]);
const kOf = (u) => Number(u.pull.exploration_draw.split("/")[1]);
const rescued = (u) => u.rows.some((r) => isImplementer(r.member) && r.subagentType !== `fleet-implementer-${u.pull.chosen_cell}`);

// issue cache
function issue(n) {
  const file = path.join(flags.cache, `${n}.json`);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    const r = spawnSync("gh", ["issue", "view", String(n), "--json", "number,title,body,labels,comments,createdAt,updatedAt,state"], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) die(`gh issue view ${n} failed: ${r.stderr.trim()}`);
    fs.writeFileSync(file, r.stdout);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// free inputs: deterministic functions of the issue text the Router already reads
const CODE_EXT = new Set(["mjs", "js", "cjs", "ts", "tsx", "jsx"]);
const DATA_EXT = new Set(["json", "jsonl", "tsv", "yml", "yaml", "toml"]);
const extOf = (p) => (/\.([A-Za-z0-9]+)$/.exec(p)?.[1] ?? "").toLowerCase();
function freeInputs(iss) {
  const brief = briefText(iss).trim();
  const paths = briefPaths(brief);
  const fences = (brief.match(/^\s*```/gm) ?? []).length;
  const extra = (iss.labels ?? []).map((l) => l.name).filter((n) => !KINDS.has(n) && n !== "ready-for-agent");
  return {
    names_md: paths.some((p) => extOf(p) === "md"),
    names_code: paths.some((p) => CODE_EXT.has(extOf(p))),
    names_sh: paths.some((p) => extOf(p) === "sh"),
    names_data: paths.some((p) => DATA_EXT.has(extOf(p))),
    names_dir: paths.some((p) => p.endsWith("/")),
    names_test: paths.some((p) => /\.test\.|(^|\/)tests?\//.test(p)),
    prose_only: paths.length > 0 && paths.every((p) => extOf(p) === "md"),
    code_blocks_any: Math.ceil(fences / 2) > 0,
    extra_labels_any: extra.length > 0,
    brief_in_comment: briefText(iss) !== String(iss.body ?? ""),
    _paths: paths, _fences: Math.ceil(fences / 2), _extraLabels: extra,
  };
}
const FREE = ["names_md", "names_code", "names_sh", "names_data", "names_dir", "names_test", "prose_only", "code_blocks_any", "extra_labels_any", "brief_in_comment"];
const issues = new Map();
for (const t of new Set(units.map((u) => u.pull.ticket))) issues.set(t, issue(t));

function rowOf(u) {
  const free = freeInputs(issues.get(u.pull.ticket));
  return {
    u, cell: u.cell, K: kOf(u), session: u.pull.session, ticket: u.pull.ticket, f: u.pull, free,
    usd: u.spend, min: u.workS / 60, merged: u.merged ? 1 : 0, claims: u.claims, failed: u.falseClaims,
    rescued: rescued(u), stratum: u.stratum,
  };
}
const allRows = tallies.flatMap((t) => t.pulls.map(rowOf)); // newest generation, counted: the Fit's per-Cell Pulls
const smolStart = allRows.filter((r) => r.cell === "smol-high").map((r) => r.session).sort()[0];

// ================================================================== report
P("# router-inputs derive output");
P();
P(`Repository HEAD ${gitHead}; window start ${WINDOW}; ${all.length} Pulls in the window, ${units.length} in the Fit's set (ticket-router.mjs:382-385); ${issues.size} distinct tickets; ${allRows.length} counted newest-generation Pulls; seed ${flags.seed}; perms ${flags.perms}; cv-null ${flags.cvNull}.`);
P(`Issue cache: ${flags.cache} (fetched at or before ${new Date(Math.max(...[...issues.values()].map((i) => Date.parse(i.updatedAt)))).toISOString()} = newest \`updatedAt\`; \`briefText\`/\`briefPaths\` run on today's text).`);
P();

// ------------------------------------------------------------------ 0. Pull set
P("## 0. The Pull set");
P();
P("Per Cell, newest generation, counted (tally(units, generations(all)).pulls); `fail` = falseClaims/claims.");
P();
P("| Cell | Model | n | failed | $/Pull mean (sd) | min/Pull mean (sd) | $/merged | min/merged |");
P("|---|---|---|---|---|---|---|---|");
for (const t of tallies) {
  const rs = allRows.filter((r) => r.cell === t.cell);
  P(`| ${t.cell} | ${t.generation} | ${t.n} | ${t.failed} | ${f2(mean(rs.map((r) => r.usd)))} (${f2(sd(rs.map((r) => r.usd)))}) | ${f1(mean(rs.map((r) => r.min)))} (${f1(sd(rs.map((r) => r.min)))}) | ${f2(t.spend / t.merged)} | ${f1(t.workS / 60 / t.merged)} |`);
}
P();
P(`Merged: ${allRows.filter((r) => r.merged).length} of ${allRows.length} counted newest-generation Pulls.`);
P();
P("Pulls in the Fit's set by status and generation (older generation, excluded, unpriced Pulls are not in the rows above):");
P();
{
  const m = new Map();
  for (const u of units) { const k = `${u.cell} | ${u.generation ?? "(none)"} | ${u.status}`; m.set(k, (m.get(k) ?? 0) + 1); }
  P("| Cell | generation | status | Pulls |");
  P("|---|---|---|---|");
  for (const [k, n] of [...m].sort()) P(`| ${k} | ${n} |`);
}
P();
P(`Distinct tickets: ${issues.size} of ${units.length} Pulls (ticket ${[...units.map((u) => u.pull.ticket)].find((t, i, a) => a.indexOf(t) !== i)} has two Pulls).`);

// rescues
const resAll = units.filter(rescued);
const resRows = allRows.filter((r) => r.rescued);
P();
P("### Rescues (an implementer row whose subagent_type is not `fleet-implementer-<chosen_cell>`)");
P();
P(`${resAll.length} of ${units.length} Fit Pulls carry one; ${resRows.length} of ${allRows.length} counted newest-generation Pulls. By drawn Cell (counted newest-gen): ${CELLS.map((c) => `${c} ${allRows.filter((r) => r.cell === c && r.rescued).length}/${allRows.filter((r) => r.cell === c).length}`).join(", ")}.`);
{
  const m = new Map();
  for (const u of resAll) for (const r of u.rows) if (isImplementer(r.member) && r.subagentType !== `fleet-implementer-${u.pull.chosen_cell}`) { const k = `${u.pull.chosen_cell} -> ${r.subagentType}`; m.set(k, (m.get(k) ?? 0) + 1); }
  P();
  P("| drawn Cell -> implementer row's subagent_type | rows |");
  P("|---|---|");
  for (const [k, n] of [...m].sort()) P(`| ${k} | ${n} |`);
}

// ------------------------------------------------------------------ 1. randomization
P();
P("## 1. Randomization check");
P();
P("`drawCell` (ledger-grammar.mjs:832-838) hashes `sha256(\"<session>\\t<ticket>\")`, takes its first 8 hex digits mod K and indexes the sorted Cell list; no feature is read. The Router calls it at ticket-router.mjs:336 with `policyCell: null` and `cells` = the table's Cells less the guard's tripped ones (rowDispatch, :213-226). K is therefore 3 while smol-high is untripped and 2 after.");
P();
{
  // reproduce each draw from (session, ticket) alone
  let ok = 0, bad = [];
  for (const u of units) {
    const K = kOf(u);
    const cells = K === 3 ? CELLS : ["slow-high", "task-high"];
    const d = drawCell({ session: u.pull.session, ticket: u.pull.ticket, policyCell: null, cells });
    if (d.cell === u.pull.chosen_cell && `${d.k}/${d.K}` === u.pull.exploration_draw) ok++; else bad.push({ t: u.pull.ticket, s: u.pull.session.slice(0, 16) });
  }
  P(`Recomputing \`drawCell({session, ticket, policyCell: null, cells})\` over the draw set implied by each Pull's recorded K reproduces the recorded Cell and \`k/K\` on ${ok} of ${units.length} Pulls${bad.length ? `. The misses are tickets ${bad.map((b) => b.t).join(", ")}, all in session ${[...new Set(bad.map((b) => b.s))].join(", ")}` : ""}. [INFERENCE] those Pulls were routed under a session string other than the row's recorded one; the recorded Cell is used as drawn.`);
}
P();
P("Draw sets by period (K from the recorded `exploration_draw`); sessions are omp session ids, which open with their start time:");
P();
P("| period | draw set | Pulls | first session | last session | smol-high drawn | slow-high | task-high |");
P("|---|---|---|---|---|---|---|---|");
for (const [name, K] of [["A (K=3)", 3], ["B (K=2)", 2]]) {
  const us = units.filter((u) => kOf(u) === K);
  const ss = us.map((u) => u.pull.session).sort();
  const c = (x) => us.filter((u) => u.pull.chosen_cell === x).length;
  P(`| ${name} | ${K === 3 ? "slow, smol, task" : "slow, task"} | ${us.length} | ${ss[0].slice(0, 16)} | ${ss.at(-1).slice(0, 16)} | ${c("smol-high")} | ${c("slow-high")} | ${c("task-high")} |`);
}
{
  const sm = units.filter((u) => u.pull.chosen_cell === "smol-high").map((u) => u.pull.session).sort();
  const gen = (g) => units.filter((u) => u.generation === g).map((u) => u.pull.session).sort();
  const h45 = gen("claude-haiku-4-5"), h55 = gen("claude-haiku-5-5");
  P();
  P(`smol-high draws: first session ${sm[0].slice(0, 16)}, last ${sm.at(-1).slice(0, 16)}. Its older generation claude-haiku-4-5 ran in sessions ${h45[0].slice(0, 16)} to ${h45.at(-1).slice(0, 16)} (${h45.length} Pulls); the newest, claude-haiku-5-5, ${h55[0].slice(0, 16)} to ${h55.at(-1).slice(0, 16)} (${h55.length} Pulls). The first period-B session (${units.filter((u) => kOf(u) === 2).map((u) => u.pull.session).sort()[0].slice(0, 16)}) starts before the last smol-high draw: sessions overlap, so the boundary used below is each Pull's recorded K, not a date.`);
  P();
  P(`Sub-period A2 = period A Pulls with session >= ${smolStart.slice(0, 16)} (the first claude-haiku-5-5 Pull): the only stretch in which all three newest-generation Cells were drawn. Every smol-high comparison below is restricted to A2.`);
}

// permutation independence tests: Cell vs input, labels permuted within period
function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
}
function independence(rows, inputs, nperm) {
  const periods = [3, 2].map((K) => rows.filter((r) => r.K === K));
  const res = [];
  for (const inp of inputs) {
    const per = periods.map((rs) => {
      const cells = [...new Set(rs.map((r) => r.cell))].sort();
      const lab = rs.map((r) => cells.indexOf(r.cell));
      if (inp.kind === "num") {
        const rk = ranks(rs.map((r) => inp.get(r)));
        return { lab, n: rs.length, C: cells.length, val: rk, stat() { const sums = new Float64Array(this.C), cnt = new Float64Array(this.C); this.lab.forEach((l, i) => { sums[l] += this.val[i]; cnt[l]++; }); const g = (this.n + 1) / 2; let h = 0; for (let c = 0; c < this.C; c++) if (cnt[c]) h += cnt[c] * (sums[c] / cnt[c] - g) ** 2; return (12 / (this.n * (this.n + 1))) * h; } };
      }
      const cats = [...new Set(rs.map((r) => String(inp.get(r))))].sort();
      const val = rs.map((r) => cats.indexOf(String(inp.get(r))));
      return { lab, n: rs.length, C: cells.length, val, stat() { const o = new Float64Array(this.C * cats.length), rt = new Float64Array(this.C), ct = new Float64Array(cats.length); this.lab.forEach((l, i) => { o[l * cats.length + this.val[i]]++; rt[l]++; ct[this.val[i]]++; }); let x = 0; for (let c = 0; c < this.C; c++) for (let k = 0; k < cats.length; k++) { const e = rt[c] * ct[k] / this.n; if (e) x += (o[c * cats.length + k] - e) ** 2 / e; } return x; } };
    });
    const rand = mulberry32(flags.seed + 7);
    const stat = () => sum(per.map((p) => p.stat()));
    const real = stat();
    let ge = 0;
    for (let it = 0; it < nperm; it++) { for (const p of per) { const pm = shuffled(p.n, rand); const l0 = p.lab.slice(); for (let i = 0; i < p.n; i++) p.lab[i] = l0[pm[i]]; } if (stat() >= real - 1e-9) ge++; }
    // restore labels for the next input is unnecessary: labels are re-derived per input
    res.push({ name: inp.name, real, p: (ge + 1) / (nperm + 1) });
  }
  return res;
}

const recordedInputs = [
  ...NUM.map((name) => ({ name, kind: "num", get: (r) => Number(r.f[name]) })),
  { name: "kind", kind: "cat", get: (r) => r.f.kind || "(none)" },
  { name: "parent", kind: "cat", get: (r) => (r.f.parent !== "" ? "slice" : "no-parent") },
];
const freeInputsDef = FREE.map((name) => ({ name, kind: "cat", get: (r) => (r.free[name] ? "yes" : "no") }));

// every Pull in the Fit's set, by drawn Cell, as drawn
const drawnRows = units.map((u) => ({ u, cell: u.pull.chosen_cell, K: kOf(u), f: u.pull, free: freeInputs(issues.get(u.pull.ticket)) }));
P();
P("Is the drawn Cell independent of the nine recorded inputs and of the free inputs? Statistic: Kruskal-Wallis H (numeric) or chi-square (categorical) of Cell against input, computed inside each period and summed; p = share of 2000 within-period shuffles of the Cell labels with a statistic at least as large (add-one). Run on (i) all 268 Pulls by drawn Cell and (ii) the counted newest-generation Pulls.");
P();
{
  const nperm = 2000;
  const a = independence(drawnRows, [...recordedInputs, ...freeInputsDef], nperm);
  const b = independence(allRows, [...recordedInputs, ...freeInputsDef], nperm);
  P("| input | (i) stat | (i) p | (ii) stat | (ii) p |");
  P("|---|---|---|---|---|");
  a.forEach((x, i) => P(`| ${x.name} | ${f2(x.real)} | ${f2(x.p)} | ${f2(b[i].real)} | ${f2(b[i].p)} |`));
  const ps = a.map((x) => x.p), pb = b.map((x) => x.p);
  const nominal = (xs) => xs.filter((p) => p < 0.05).length;
  P();
  P(`${a.length} inputs tested; ${nominal(ps)} of ${ps.length} with p < 0.05 in (i) (about ${(ps.length * 0.05).toFixed(1)} expected by chance), ${nominal(pb)} of ${pb.length} in (ii). Smallest p: (i) ${f2(Math.min(...ps))}, (ii) ${f2(Math.min(...pb))}; Bonferroni threshold ${(0.05 / ps.length).toFixed(4)}.`);
}
P();
P("Recorded-input medians by drawn Cell (all 268 Pulls; the counted newest-generation Pulls give the same picture, see (ii) above):");
P();
P(`| input | ${CELLS.join(" | ")} |`);
P("|---|---|---|---|");
for (const n of NUM) P(`| ${n} | ${CELLS.map((c) => f1(median(drawnRows.filter((r) => r.cell === c).map((r) => Number(r.f[n]))))).join(" | ")} |`);
for (const k of ["bug", "enhancement", "documentation", ""]) P(`| kind=${k || "(none)"} (n) | ${CELLS.map((c) => drawnRows.filter((r) => r.cell === c && r.f.kind === k).length).join(" | ")} |`);
P(`| parent present (n) | ${CELLS.map((c) => drawnRows.filter((r) => r.cell === c && r.f.parent !== "").length).join(" | ")} |`);
P(`| Pulls | ${CELLS.map((c) => drawnRows.filter((r) => r.cell === c).length).join(" | ")} |`);

// ------------------------------------------------------------------ free-input audit
P();
P("## 2a. Free inputs: how they reproduce the recorded ones");
P();
{
  const mm = { brief_chars: 0, criteria: 0, paths: 0, test_paths: 0, comments: 0 };
  for (const r of allRows) {
    const m = issueMetrics(issues.get(r.ticket), Date.parse(r.f.run_date));
    for (const c of Object.keys(mm)) if (String(m[c]) !== String(r.f[c])) mm[c]++;
  }
  P(`Re-running the Router's own \`issueMetrics\` on today's issues and comparing to the recorded columns over the ${allRows.length} counted newest-generation Pulls: differing rows ${Object.entries(mm).map(([k, v]) => `${k} ${v}`).join(", ")}. The text-derived inputs below are today's text; where a Pull's recomputed brief_chars, paths or test_paths differ from the recorded value the ticket's text has changed since dispatch, so its text-derived inputs may differ from what the Router could have read then; those Pulls are kept (no run drops them).`);
  const pathN = new Map(), ext = new Map();
  for (const r of allRows) for (const p of r.free._paths) { const e = extOf(p) || (p.endsWith("/") ? "(dir)" : "(none)"); ext.set(e, (ext.get(e) ?? 0) + 1); }
  P();
  P(`Distinct-per-Pull path tokens by extension (top): ${[...ext].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([e, n]) => `${e} ${n}`).join(", ")}.`);
  const fence = new Map();
  for (const r of allRows) fence.set(r.free._fences, (fence.get(r.free._fences) ?? 0) + 1);
  P(`Fenced code blocks per brief (count of Pulls): ${[...fence].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}: ${n}`).join(", ")}.`);
  const lab = new Map();
  for (const r of allRows) for (const l of r.free._extraLabels) lab.set(l, (lab.get(l) ?? 0) + 1);
  const rawLab = new Map();
  for (const r of allRows) for (const l of issues.get(r.ticket).labels) rawLab.set(l.name, (rawLab.get(l.name) ?? 0) + 1);
  P(`Labels on the counted Pulls' issues: ${[...rawLab].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}. "Labels beyond kind" here also leaves out \`ready-for-agent\` (on ${rawLab.get("ready-for-agent")} of ${allRows.length}): the rest are ${[...lab].map(([k, n]) => `${k} ${n}`).join(", ")}.`);
  P(`Briefs taken from an \`## Agent Brief\` comment: ${allRows.filter((r) => r.free.brief_in_comment).length} of ${allRows.length}; from the body: ${allRows.filter((r) => !r.free.brief_in_comment).length}.`);
  P(`Counts of Pulls with each boolean free input true: ${FREE.map((n) => `${n} ${allRows.filter((r) => r.free[n]).length}`).join(", ")}.`);
}

// ================================================================== analysis engine
const cellIdxOf = (c) => CELLS.indexOf(c);

/** The per-input split specs over a row pool: numeric at the pool median, bool/cat by category. */
function splitSpecs(pool) {
  const specs = [];
  for (const n of NUM) {
    const vals = pool.map((r) => Number(r.f[n]));
    let med = median(vals), strict = true;
    if (!vals.some((v) => v > med)) strict = false;
    specs.push({ input: n, cut: strict ? `> ${med}` : `>= ${med}`, side: (r) => (strict ? Number(r.f[n]) > med : Number(r.f[n]) >= med), hiLabel: strict ? `> ${med}` : `>= ${med}`, loLabel: strict ? `<= ${med}` : `< ${med}` });
  }
  for (const k of ["bug", "enhancement", "documentation", ""]) specs.push({ input: "kind", cut: `= ${k || "(none)"}`, side: (r) => r.f.kind === k, hiLabel: `= ${k || "(none)"}`, loLabel: `not ${k || "(none)"}` });
  specs.push({ input: "parent", cut: "has parent", side: (r) => r.f.parent !== "", hiLabel: "Slice (parent)", loLabel: "no parent" });
  for (const n of FREE) specs.push({ input: n, cut: "true", side: (r) => r.free[n], hiLabel: "yes", loLabel: "no", free: true });
  return specs;
}
const U = (rows, key) => rows.map((r) => (key === "usd" ? { num: r.usd, den: r.merged } : key === "min" ? { num: r.min, den: r.merged } : { num: r.failed * 100, den: r.claims }));
const figs = (rows) => ({
  n: rows.length,
  usd: rows.length ? sum(rows.map((r) => r.usd)) / sum(rows.map((r) => r.merged)) : null,
  min: rows.length ? sum(rows.map((r) => r.min)) / sum(rows.map((r) => r.merged)) : null,
  failed: sum(rows.map((r) => r.failed)), claims: sum(rows.map((r) => r.claims)),
  fail: rows.length && sum(rows.map((r) => r.claims)) ? (100 * sum(rows.map((r) => r.failed))) / sum(rows.map((r) => r.claims)) : null,
});
const METRICS = [["usd", 2], ["min", 2], ["fail", 1]];
const SEEDS = { usd: 1, min: 2, fail: 3 };

/** Bootstrap range of (cell - base) on one side. */
function gapCI(rows, cell, base, key) {
  const dec = key === "fail" ? 1 : 2;
  return boot([U(rows.filter((r) => r.cell === cell), key), U(rows.filter((r) => r.cell === base), key)], (r) => r[0] - r[1], { dec });
}
function gapPoint(rows, cell, base, key) {
  const a = ratio(U(rows.filter((r) => r.cell === cell), key)), b = ratio(U(rows.filter((r) => r.cell === base), key));
  return a === null || b === null ? null : a - b;
}
/** Interaction: (gap on side 1) - (gap on side 2). */
function interCI(s1, s2, cell, base, key) {
  const dec = key === "fail" ? 1 : 2;
  return boot([U(s1.filter((r) => r.cell === cell), key), U(s1.filter((r) => r.cell === base), key), U(s2.filter((r) => r.cell === cell), key), U(s2.filter((r) => r.cell === base), key)], (r) => (r[0] - r[1]) - (r[2] - r[3]), { dec });
}
/** Period-stratified gap: periods A (K=3) and B (K=2) weighted by the side's Pulls in each, resampled within period x Cell. */
function stratGap(rows, cell, base, key) {
  const dec = key === "fail" ? 1 : 2;
  const A = rows.filter((r) => r.K === 3), B = rows.filter((r) => r.K === 2);
  const g = [U(A.filter((r) => r.cell === cell), key), U(A.filter((r) => r.cell === base), key), U(B.filter((r) => r.cell === cell), key), U(B.filter((r) => r.cell === base), key)];
  if (g.some((x) => x.length === 0)) return { point: null, ci: null };
  const wA = (g[0].length + g[1].length) / (g[0].length + g[1].length + g[2].length + g[3].length), wB = 1 - wA;
  const f = (r) => wA * (r[0] - r[1]) + wB * (r[2] - r[3]);
  const point = f(g.map((x) => ratio(x)));
  return { point, ci: boot(g, f, { dec }) };
}
const MDE_K = 1.959964 + 0.841621; // two-sided 5%, 80% power
function mde(rowsPerCell /* [rowsA,rowsB,...] groups whose gap(s) combine */, key) {
  // gap = mean(A)-mean(B) ([2 groups]) or interaction ([4 groups]: (A1-B1)-(A2-B2))
  const v = rowsPerCell.map((rs) => {
    const n = rs.length;
    if (n < 2) return NaN;
    if (key === "fail") { const c = sum(rs.map((r) => r.claims)), p = sum(rs.map((r) => r.failed)) / c; return (100 * 100 * p * (1 - p)) / c; }
    const x = rs.map((r) => (key === "usd" ? r.usd : r.min));
    return sd(x) ** 2 / n;
  });
  return MDE_K * Math.sqrt(sum(v));
}

// ================================================================== sections 2-3: per-input tables
function perInputSection(rows, title, pair /* [cell, base] */, { minShow = 1, tag } = {}) {
  const [cell, base] = pair;
  const specs = splitSpecs(rows);
  P();
  P(`### ${title}`);
  P();
  const top = [rows.filter((r) => r.cell === cell), rows.filter((r) => r.cell === base)];
  P(`Pool: ${rows.length} Pulls (${cell} ${top[0].length}, ${base} ${top[1].length}). Gap = ${cell} - ${base}; range = bootstrap 95% (2000 resamples, Pulls resampled within Cell and side, the Router's bootstrapDiffCI draw order); * = range excludes 0. $ and minutes are per merged PR; fail = false claims / claims, in %, and its gap in points. \`MDE\` = smallest gap 80%-powered at 5% two-sided from the measured per-Pull sd and n on that side (fail: binomial).`);
  P();
  // top-level
  {
    const ta = figs(top[0]), tb = figs(top[1]);
    const g = Object.fromEntries(METRICS.map(([k]) => [k, gapCI(rows, cell, base, k)]));
    const rep = bootstrapDiffCI(top[0].map((r) => bootUnit(r.u, "usd")), top[1].map((r) => bootUnit(r.u, "usd")));
    P(`All Pulls: $ ${f2(ta.usd)} vs ${f2(tb.usd)}, gap ${sgn2(gapPoint(rows, cell, base, "usd"))} ${rng(g.usd)}${sig(g.usd)}; minutes ${f1(ta.min)} vs ${f1(tb.min)}, gap ${sgn2(gapPoint(rows, cell, base, "min"))} ${rng(g.min)}${sig(g.min)}; fail ${ta.failed}/${ta.claims} vs ${tb.failed}/${tb.claims}, gap ${sgn1(gapPoint(rows, cell, base, "fail"))} pts ${rng(g.fail, 1)}${sig(g.fail)}. Router \`bootstrapDiffCI\` on the same $ units: ${rng(rep)} (${JSON.stringify(rep) === JSON.stringify(g.usd) ? "identical to the generic bootstrap here" : "DIFFERS"}). MDE (80% power, 5% two-sided) on these Pulls: $ ${f2(mde(top, "usd"))}, minutes ${f1(mde(top, "min"))}, fail ${f1(mde(top, "fail"))} pts.`);
  }
  P();
  P(`| input | side | n ${cell} | n ${base} | $ ${cell} | $ ${base} | $ gap [range] | MDE $ | min ${cell} | min ${base} | min gap [range] | MDE min | fail ${cell} | fail ${base} | fail gap pts [range] |`);
  P("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  const inter = [];
  const enough = [];
  for (const sp of specs) {
    const hi = rows.filter((r) => sp.side(r)), lo = rows.filter((r) => !sp.side(r));
    if (hi.length < 2 || lo.length < 2) { P(`| ${sp.input} (${sp.cut}) | - | side empty | | | | | | | | | | | | |`); continue; }
    for (const [lab, side] of [[sp.loLabel, lo], [sp.hiLabel, hi]]) {
      const a = side.filter((r) => r.cell === cell), b = side.filter((r) => r.cell === base);
      const fa = figs(a), fb = figs(b);
      const g = Object.fromEntries(METRICS.map(([k]) => [k, a.length && b.length ? gapCI(side, cell, base, k) : null]));
      if (a.length >= MIN_N && b.length >= MIN_N) enough.push({ input: sp.input, lab, a, b, fa, fb, g });
      P(`| ${sp.input} | ${lab} | ${a.length} | ${b.length} | ${f2(fa.usd)} | ${f2(fb.usd)} | ${a.length && b.length ? `${sgn2(fa.usd - fb.usd)} ${rng(g.usd)}${sig(g.usd)}` : "-"} | ${a.length > 1 && b.length > 1 ? f2(mde([a, b], "usd")) : "-"} | ${f1(fa.min)} | ${f1(fb.min)} | ${a.length && b.length ? `${sgn1(fa.min - fb.min)} ${rng(g.min, 1)}${sig(g.min)}` : "-"} | ${a.length > 1 && b.length > 1 ? f1(mde([a, b], "min")) : "-"} | ${fa.failed}/${fa.claims} (${f1(fa.fail)}%) | ${fb.failed}/${fb.claims} (${f1(fb.fail)}%) | ${a.length && b.length ? `${sgn1(fa.fail - fb.fail)} ${rng(g.fail, 1)}${sig(g.fail)}` : "-"} |`);
    }
    const cellsIn = (s) => [s.filter((r) => r.cell === cell), s.filter((r) => r.cell === base)];
    const [h1, h2] = cellsIn(hi), [l1, l2] = cellsIn(lo);
    if (h1.length && h2.length && l1.length && l2.length) {
      const ic = Object.fromEntries(METRICS.map(([k]) => [k, interCI(hi, lo, cell, base, k)]));
      const pt = (k) => gapPoint(hi, cell, base, k) - gapPoint(lo, cell, base, k);
      inter.push({ sp, pt, ic, mde: { usd: mde([h1, h2, l1, l2], "usd"), min: mde([h1, h2, l1, l2], "min"), fail: mde([h1, h2, l1, l2], "fail") }, n: [h1.length, h2.length, l1.length, l2.length] });
    } else inter.push({ sp, none: true, n: [h1.length, h2.length, l1.length, l2.length] });
  }
  if (tag === "a2") {
    P();
    P(`Sides where both Cells have at least the Router's MIN_N (${MIN_N}) Pulls: ${enough.length} of ${specs.length * 2}.`);
    if (enough.length) {
      P();
      P(`| input | side | n ${cell} | n ${base} | $ gap [range] | min gap [range] | fail gap pts [range] |`);
      P("|---|---|---|---|---|---|---|");
      for (const x of enough) P(`| ${x.input} | ${x.lab} | ${x.a.length} | ${x.b.length} | ${sgn2(x.fa.usd - x.fb.usd)} ${rng(x.g.usd)}${sig(x.g.usd)} | ${sgn1(x.fa.min - x.fb.min)} ${rng(x.g.min, 1)}${sig(x.g.min)} | ${sgn1(x.fa.fail - x.fb.fail)} ${rng(x.g.fail, 1)}${sig(x.g.fail)} |`);
    }
  }
  P();
  P(`Interaction = (gap on the \`yes\`/high/in-category side) - (gap on the other side), ${cell} - ${base}; range = bootstrap 95% of the four groups resampled independently. A range excluding 0 means the gap differs between sides. n = [side1 ${cell}, side1 ${base}, side2 ${cell}, side2 ${base}].`);
  P();
  P("| input | cut | n | $ interaction [range] | MDE $ | min interaction [range] | MDE min | fail interaction pts [range] | MDE fail pts |");
  P("|---|---|---|---|---|---|---|---|---|");
  for (const x of inter) {
    if (x.none) { P(`| ${x.sp.input} | ${x.sp.cut} | ${x.n.join("/")} | not estimable: a Cell is absent on a side | | | | | |`); continue; }
    P(`| ${x.sp.input} | ${x.sp.cut} | ${x.n.join("/")} | ${sgn2(x.pt("usd"))} ${rng(x.ic.usd)}${sig(x.ic.usd)} | ${f2(x.mde.usd)} | ${sgn2(x.pt("min"))} ${rng(x.ic.min)}${sig(x.ic.min)} | ${f2(x.mde.min)} | ${sgn1(x.pt("fail"))} ${rng(x.ic.fail, 1)}${sig(x.ic.fail)} | ${f1(x.mde.fail)} |`);
  }
  {
    const est = inter.filter((x) => !x.none);
    const rg = (k) => `${Math.min(...est.map((x) => x.mde[k])).toFixed(k === "usd" ? 2 : 1)} to ${Math.max(...est.map((x) => x.mde[k])).toFixed(k === "usd" ? 2 : 1)}`;
    P();
    P(`Smallest interaction detectable (80% power, 5% two-sided) across the ${est.length} estimable splits: $ ${rg("usd")}, minutes ${rg("min")}, fail ${rg("fail")} pts.`);
  }
  const nSig = inter.filter((x) => !x.none && ["usd", "min", "fail"].some((k) => x.ic[k] && (x.ic[k][0] > 0 || x.ic[k][1] < 0))).length;
  P();
  P(`${inter.filter((x) => !x.none).length} interactions estimated x 3 metrics = ${inter.filter((x) => !x.none).length * 3} ranges; ${["usd", "min", "fail"].map((k) => `${k}: ${inter.filter((x) => !x.none && x.ic[k] && (x.ic[k][0] > 0 || x.ic[k][1] < 0)).length} exclude 0`).join(", ")} (at 95%, about ${(inter.filter((x) => !x.none).length * 0.05).toFixed(1)} per metric expected by chance alone; the inputs are not independent).`);
  // period-stratified
  if (tag === "pair") {
    P();
    P(`Period-stratified gap (${cell} - ${base}; gap inside period A (K=3) and B (K=2), weighted by the side's Pulls in each; resampled within period x Cell):`);
    P();
    P("| input | side | $ gap [range] | min gap [range] |");
    P("|---|---|---|---|");
    const tl = (rows2) => { const s = stratGap(rows2, cell, base, "usd"), m = stratGap(rows2, cell, base, "min"); return [s, m]; };
    { const [s, m] = tl(rows); P(`| (all Pulls) | - | ${s.point === null ? "-" : sgn2(s.point)} ${rng(s.ci)}${sig(s.ci)} | ${m.point === null ? "-" : sgn2(m.point)} ${rng(m.ci)}${sig(m.ci)} |`); }
    for (const sp of specs) {
      for (const [lab, side] of [[sp.loLabel, rows.filter((r) => !sp.side(r))], [sp.hiLabel, rows.filter((r) => sp.side(r))]]) {
        if (side.length < 2) continue;
        const [s, m] = tl(side);
        P(`| ${sp.input} | ${lab} | ${s.point === null ? "-" : sgn2(s.point)} ${rng(s.ci)}${sig(s.ci)} | ${m.point === null ? "-" : sgn2(m.point)} ${rng(m.ci, 2)}${sig(m.ci)} |`);
      }
    }
  }
}

// ================================================================== gain engine
/**
 * Candidate partitions over a row pool: for each input, cuts at the pool's
 * 25/50/75th percentiles (numeric), each category set (kind), or the boolean.
 * Each is { input, label, G, gid:Int8Array(N) } where gid[i] is row i's group.
 * A cut whose smaller side holds fewer than 2*minN rows is dropped (no group
 * could hold minN of each Cell); the same filter runs on every permutation
 * because a shuffled column keeps its distribution.
 */
function candidates(rows, cellsIn, minN) {
  const N = rows.length;
  const byInput = new Map();
  const add = (input, label, gid, G) => {
    const counts = new Array(G).fill(0);
    gid.forEach((g) => counts[g]++);
    if (G === 2 && counts.some((c) => c < 2 * minN)) return;
    const sigs = (byInput.get(input) ?? byInput.set(input, []).get(input));
    const key = Array.from(gid).join("");
    if (sigs.some((s) => s.key === key)) return;
    sigs.push({ input, label, G, gid, key });
  };
  for (const n of NUM) {
    const vals = rows.map((r) => Number(r.f[n]));
    const s = sortedNum(vals);
    for (const q of [0.25, 0.5, 0.75]) {
      const t = quantile(s, q);
      add(n, `${n} > ${t}`, Int8Array.from(vals, (v) => (v > t ? 1 : 0)), 2);
    }
  }
  {
    const ks = ["bug", "enhancement", "documentation", ""];
    add("kind", "kind (bug | enhancement | documentation | none)", Int8Array.from(rows, (r) => ks.indexOf(r.f.kind)), 4);
  }
  add("parent", "parent present", Int8Array.from(rows, (r) => (r.f.parent !== "" ? 1 : 0)), 2);
  for (const n of FREE) add(n, `${n}`, Int8Array.from(rows, (r) => (r.free[n] ? 1 : 0)), 2);
  return [...byInput.values()].flat();
}
// The Router's current split is a candidate of its own, scored the same way.
const strataGid = (rows) => { const ss = ["light", "heavy", "unknown"]; return Int8Array.from(rows, (r) => ss.indexOf(r.stratum)); };

class Engine {
  constructor(rows, cells, minN) {
    this.rows = rows; this.N = rows.length; this.C = cells.length; this.cells = cells; this.minN = minN;
    this.cell = Int8Array.from(rows, (r) => cells.indexOf(r.cell));
    this.usd = Float64Array.from(rows, (r) => r.usd); this.min = Float64Array.from(rows, (r) => r.min);
    this.merged = Float64Array.from(rows, (r) => r.merged); this.claims = Float64Array.from(rows, (r) => r.claims); this.failed = Float64Array.from(rows, (r) => r.failed);
  }
  /** group x cell sums over `idx` (all rows when null): [n, usd, min, merged, claims, failed] */
  stats(gid, G, idx = null) {
    const s = new Float64Array(G * this.C * 6);
    const add = (i) => { const o = (gid[i] * this.C + this.cell[i]) * 6; s[o]++; s[o + 1] += this.usd[i]; s[o + 2] += this.min[i]; s[o + 3] += this.merged[i]; s[o + 4] += this.claims[i]; s[o + 5] += this.failed[i]; };
    if (idx === null) for (let i = 0; i < this.N; i++) add(i); else for (let k = 0; k < idx.length; k++) add(idx[k]);
    return s;
  }
  /** the Cell a group takes under `metric` (1 usd, 2 min): lowest per merged PR among the Cells with >= minN Pulls that clear the floor against Cell 0; fallback otherwise */
  pick(s, g, metric, fallback) {
    const C = this.C, o0 = g * C * 6;
    let best = -1, bestV = Infinity;
    for (let c = 0; c < C; c++) {
      const o = o0 + c * 6;
      if (s[o] < this.minN || s[o + 3] === 0) continue;
      if (c !== 0) {
        if (s[o0] < this.minN) continue;
        if (underFloor({ failed: s[o + 5], claims: s[o + 4] }, { failed: s[o0 + 5], claims: s[o0 + 4] })) continue;
      }
      const v = s[o + metric] / s[o + 3];
      if (v < bestV) { bestV = v; best = c; }
    }
    return best === -1 ? fallback : best;
  }
  /** value of a partition: routed per-merged-PR figure with groups weighted by their share of Pulls, each at its picked Cell */
  value(s, G, metric, choice) {
    let num = 0, den = 0, total = 0;
    for (let g = 0; g < G; g++) for (let c = 0; c < this.C; c++) total += s[(g * this.C + c) * 6];
    for (let g = 0; g < G; g++) {
      let o = (g * this.C + choice[g]) * 6;
      let n = s[o];
      let u = s[o + metric], m = s[o + 3];
      if (n === 0) { // chosen Cell absent in the group: the group's pooled Pulls stand in
        n = 0; u = 0; m = 0;
        for (let c = 0; c < this.C; c++) { const q = (g * this.C + c) * 6; n += s[q]; u += s[q + metric]; m += s[q + 3]; }
      }
      if (n === 0) continue;
      let gn = 0;
      for (let c = 0; c < this.C; c++) gn += s[(g * this.C + c) * 6];
      const w = gn / total;
      num += w * (u / n); den += w * (m / n);
    }
    return den ? num / den : NaN;
  }
  baseline(metric, idx = null) {
    const gid = new Int8Array(this.N);
    const s = this.stats(gid, 1, idx);
    const c0 = this.pick(s, 0, metric, 0);
    return { cell: c0, value: this.value(s, 1, metric, [c0]), s };
  }
  /** gain of a partition over the one-Cell baseline, and the per-group choices */
  gain(gid, G, metric, base, idx = null, s = this.stats(gid, G, idx)) {
    const choice = new Int8Array(G);
    for (let g = 0; g < G; g++) choice[g] = this.pick(s, g, metric, base.cell);
    // Both values weight the groups by their share of all Pulls, so a grouping that moves no group off the one-Cell choice gains exactly 0.
    const one = new Int8Array(G).fill(base.cell);
    return { gain: this.value(s, G, metric, one) - this.value(s, G, metric, choice), choice, s };
  }
}

function product(a, b) { const g = new Int8Array(a.gid.length); for (let i = 0; i < g.length; i++) g[i] = a.gid[i] * b.G + b.gid[i]; return { gid: g, G: a.G * b.G }; }

/** all depth-1 and depth-2 (two different inputs) partitions' gains for both metrics; returns arrays aligned to `defs` */
function scan(eng, cands, bases, perms /* optional: Map input -> Int32Array permutation */, idx = null) {
  const shuf = (c) => { if (!perms) return c.gid; const p = perms.get(c.input), g = new Int8Array(c.gid.length); for (let i = 0; i < g.length; i++) g[i] = c.gid[p[i]]; return g; };
  const sc = cands.map((c) => ({ ...c, gid: shuf(c) }));
  const res = [];
  for (const c of sc) {
    const r = { d: 1, a: c, b: null, gain: [null, null, null] };
    const s = eng.stats(c.gid, c.G, idx);
    for (const m of [1, 2]) r.gain[m] = eng.gain(c.gid, c.G, m, bases[m], idx, s).gain;
    res.push(r);
  }
  for (let i = 0; i < sc.length; i++) for (let j = i + 1; j < sc.length; j++) {
    if (sc[i].input === sc[j].input) continue;
    const { gid, G } = product(sc[i], sc[j]);
    const r = { d: 2, a: sc[i], b: sc[j], gain: [null, null, null] };
    const s = eng.stats(gid, G, idx);
    for (const m of [1, 2]) r.gain[m] = eng.gain(gid, G, m, bases[m], idx, s).gain;
    res.push(r);
  }
  return res;
}
const maxGain = (res, depth, m) => { let b = -Infinity; for (const r of res) if (r.d <= depth && r.gain[m] > b) b = r.gain[m]; return b; };
const pctl = (xs, q) => quantile(sortedNum(xs), q);

function gainSection(rows, cells, title, minN, perms) {
  const eng = new Engine(rows, cells, minN);
  const cands = candidates(rows, cells, minN);
  const bases = [null, eng.baseline(1), eng.baseline(2)];
  P();
  P(`### ${title}`);
  P();
  P(`Pool ${rows.length} Pulls (${cells.map((c) => `${c} ${rows.filter((r) => r.cell === c).length}`).join(", ")}); candidate cuts ${cands.length} over ${new Set(cands.map((c) => c.input)).size} inputs; depth-2 = every pair of cuts of two different inputs; a group needs >= ${minN} Pulls of a Cell for that Cell to be picked there, and a non-default Cell must clear the floor (underFloor, ${TRIP_POINTS} points) against ${cells[0]} in that group. One-Cell baseline: $ ${bases[1].value.toFixed(2)}/merged at ${cells[bases[1].cell]}; minutes ${bases[2].value.toFixed(1)}/merged at ${cells[bases[2].cell]}.`);
  const real = scan(eng, cands, bases, null);
  const depthN = (d) => real.filter((r) => r.d === d).length;
  P(`Partitions scored: ${depthN(1)} one-input, ${depthN(2)} two-input.`);
  // Router's current split
  {
    const gid = strataGid(rows);
    const used = [...new Set(gid)].length;
    const g1 = eng.gain(gid, 3, 1, bases[1]), g2 = eng.gain(gid, 3, 2, bases[2]);
    const names = ["light", "heavy", "unknown"];
    P();
    P(`The Router's current light/heavy split (ruleStratum): $ gain ${f2(g1.gain)}/merged (${(100 * g1.gain / bases[1].value).toFixed(1)}%), minutes gain ${f2(g2.gain)} (${(100 * g2.gain / bases[2].value).toFixed(1)}%); Pulls light ${rows.filter((r) => r.stratum === "light").length}, heavy ${rows.filter((r) => r.stratum === "heavy").length}, unknown ${rows.filter((r) => r.stratum === "unknown").length}; $ picks ${names.map((n, g) => `${n}: ${cells[g1.choice[g]]}`).join(", ")}; minutes picks ${names.map((n, g) => `${n}: ${cells[g2.choice[g]]}`).join(", ")}.`);
  }
  // top lists
  for (const [m, name, unit, d] of [[1, "$ per merged PR", "$", 2], [2, "minutes per merged PR", "min", 1]]) {
    for (const depth of [1, 2]) {
      const top = real.filter((r) => r.d === depth).sort((a, b) => b.gain[m] - a.gain[m]).slice(0, 5);
      P();
      P(`Top ${depth === 1 ? "one-input" : "two-input"} groupings by ${name} (gain = one-Cell value - routed value; positive is better):`);
      P();
      P("| grouping | gain | % of baseline | per-group pick (Cells in order slow/task[/smol]) |");
      P("|---|---|---|---|");
      for (const r of top) {
        const { gid, G } = r.d === 1 ? { gid: r.a.gid, G: r.a.G } : product(r.a, r.b);
        const g = eng.gain(gid, G, m, bases[m]);
        const desc = [];
        for (let k = 0; k < G; k++) { const ns = cells.map((_, c) => g.s[(k * cells.length + c) * 6]), fl = cells.map((_, c) => g.s[(k * cells.length + c) * 6 + 5]); desc.push(`g${k}: ${cells[g.choice[k]]} (n ${ns.join("/")}; failed ${fl.join("/")})`); }
        P(`| ${r.a.label}${r.b ? ` & ${r.b.label}` : ""} | ${r.gain[m].toFixed(d)} ${unit} | ${(100 * r.gain[m] / bases[m].value).toFixed(1)}% | ${desc.join("; ")} |`);
      }
    }
  }
  // permutation nulls
  const nulls = {};
  for (const mode of ["column", "row"]) {
    const rand = mulberry32(flags.seed + (mode === "column" ? 1 : 2));
    const mx = { 1: { 1: [], 2: [] }, 2: { 1: [], 2: [] } };
    for (let it = 0; it < flags.perms; it++) {
      const perms = new Map();
      if (mode === "row") { const p = shuffled(rows.length, rand); for (const c of cands) perms.set(c.input, p); } else for (const c of cands) if (!perms.has(c.input)) perms.set(c.input, shuffled(rows.length, rand));
      const res = scan(eng, cands, bases, perms);
      for (const m of [1, 2]) for (const depth of [1, 2]) mx[m][depth].push(maxGain(res, depth, m));
    }
    nulls[mode] = mx;
  }
  P();
  P(`Permutation null over ${flags.perms} shuffles: for each shuffle the max gain over every candidate partition of that depth is kept. "column" shuffles each input's column across Pulls independently; "row" shuffles whole feature rows against the outcomes (keeps the inputs' mutual correlation); with one input the two are the same null. Both leave each Pull's drawn Cell and outcome together. p = (1 + #null max >= real best)/(1 + shuffles).`);
  P();
  P("| metric | depth | real best gain | null median | null 95th pct | null max | p (column) | p (row) | 95th pct (row) |");
  P("|---|---|---|---|---|---|---|---|---|");
  for (const [m, name, d] of [[1, "$ per merged PR", 2], [2, "minutes per merged PR", 2]]) for (const depth of [1, 2]) {
    const rb = maxGain(real, depth, m);
    const pv = (mode) => (1 + nulls[mode][m][depth].filter((x) => x >= rb - 1e-12).length) / (1 + nulls[mode][m][depth].length);
    const col = nulls.column[m][depth];
    P(`| ${name} | ${depth === 1 ? "<= 1 input" : "<= 2 inputs"} | ${rb.toFixed(d)} (${(100 * rb / bases[m].value).toFixed(1)}%) | ${pctl(col, 0.5).toFixed(d)} | ${pctl(col, 0.95).toFixed(d)} | ${Math.max(...col).toFixed(d)} | ${pv("column").toFixed(3)} | ${pv("row").toFixed(3)} | ${pctl(nulls.row[m][depth], 0.95).toFixed(d)} |`);
  }
  return { eng, cands, bases, real, nulls };
}

// k-fold cross-validation: choose the best partition on the training folds, score it on the held-out fold by the randomization (matched-draw estimate)
function cvSection(rows, cells, minN, title, cvRepeats = 10, folds = 5) {
  const eng = new Engine(rows, cells, minN);
  const cands = candidates(rows, cells, minN);
  const N = rows.length;
  function oneCV(depth, m, rand, perm /* row permutation of the features, or null */) {
    const order = shuffled(N, rand);
    const fold = new Int32Array(N);
    order.forEach((i, k) => { fold[i] = k % folds; });
    const perms = perm ? new Map(cands.map((c) => [c.input, perm])) : null;
    const sc = cands.map((c) => { if (!perms) return c; const g = new Int8Array(N); for (let i = 0; i < N; i++) g[i] = c.gid[perm[i]]; return { ...c, gid: g }; });
    let pm = [0, 0], bm = [0, 0]; // matched sums [value, merged] for the policy and the baseline
    const chosen = [];
    for (let f = 0; f < folds; f++) {
      const tr = [], te = [];
      for (let i = 0; i < N; i++) (fold[i] === f ? te : tr).push(i);
      const base = eng.baseline(m, tr);
      let best = { gain: 0, gid: null, G: 1, choice: [base.cell], label: "(none: one Cell)" };
      const consider = (gid, G, label) => { const g = eng.gain(gid, G, m, base, tr); if (g.gain > best.gain + 1e-12) best = { gain: g.gain, gid, G, choice: g.choice, label }; };
      for (const c of sc) consider(c.gid, c.G, c.label);
      if (depth === 2) for (let i = 0; i < sc.length; i++) for (let j = i + 1; j < sc.length; j++) { if (sc[i].input === sc[j].input) continue; const p = product(sc[i], sc[j]); consider(p.gid, p.G, `${sc[i].label} & ${sc[j].label}`); }
      chosen.push(best.label);
      for (const i of te) {
        const g = best.gid ? best.gid[i] : 0;
        const pc = best.choice[g];
        const key = m === 1 ? eng.usd[i] : eng.min[i];
        if (eng.cell[i] === pc) { pm[0] += key; pm[1] += eng.merged[i]; }
        if (eng.cell[i] === base.cell) { bm[0] += key; bm[1] += eng.merged[i]; }
      }
    }
    return { gain: bm[0] / bm[1] - pm[0] / pm[1], base: bm[0] / bm[1], chosen };
  }
  P();
  P(`### ${title}`);
  P();
  P(`${folds}-fold cross-validation, ${cvRepeats} repeats (random folds). In each fold the best partition (highest in-sample gain; depth <= 1 or <= 2; the one-Cell rule if nothing gains) is chosen on the training Pulls and applied to the held-out ones. A held-out Pull counts toward a policy's value only where its drawn Cell is the one the policy picks (the draw is uniform over the pool's two Cells within each period, so the matched Pulls are an unbiased sample of that policy); the one-Cell baseline (Cell chosen on training) is scored the same way. CV gain = baseline - policy, pooled over the folds. Null: ${flags.cvNull} whole-feature-row shuffles, one CV pass each.`);
  P();
  P("| metric | depth | CV gain mean over repeats [min, max] | % of baseline | null mean | null 95th pct | repeats with gain > null 95th pct | most-chosen split |");
  P("|---|---|---|---|---|---|---|---|");
  for (const [m, name, d] of [[1, "$ per merged PR", 2], [2, "minutes per merged PR", 2]]) for (const depth of [1, 2]) {
    const rand = mulberry32(flags.seed + 100 + m * 10 + depth);
    const reps = Array.from({ length: cvRepeats }, () => oneCV(depth, m, rand, null));
    const nrand = mulberry32(flags.seed + 200 + m * 10 + depth);
    const nul = Array.from({ length: flags.cvNull }, () => oneCV(depth, m, nrand, shuffled(N, nrand)).gain);
    const g = reps.map((r) => r.gain), p95 = pctl(nul, 0.95);
    const tally2 = new Map();
    reps.forEach((r) => r.chosen.forEach((c) => tally2.set(c, (tally2.get(c) ?? 0) + 1)));
    const top = [...tally2].sort((a, b) => b[1] - a[1])[0];
    P(`| ${name} | <= ${depth} | ${g.length ? mean(g).toFixed(d) : "-"} [${Math.min(...g).toFixed(d)}, ${Math.max(...g).toFixed(d)}] | ${(100 * mean(g) / mean(reps.map((r) => r.base))).toFixed(1)}% | ${mean(nul).toFixed(d)} | ${p95.toFixed(d)} | ${g.filter((x) => x > p95).length}/${g.length} | ${top[0]} (${top[1]}/${cvRepeats * folds} folds) |`);
  }
}

// ================================================================== run
const pairPool = allRows.filter((r) => r.cell !== "smol-high"); // slow-high and task-high, all periods
const pairNoRescue = pairPool.filter((r) => !r.rescued);

P();
P("## 2. Per-input splits: task-high vs slow-high (as routed, intent-to-treat)");
P();
P("The Fit books a whole Pull to the Cell it drew, whatever rescued it (#3675); this section does the same. Pool = every counted newest-generation slow-high and task-high Pull, periods A and B together (both Cells are drawn in both periods at equal odds, so period does not bias their gap; the period-stratified table checks that).");
{
  P();
  P("### 2.0 By draw-set period (every Pull, newest generation, counted)");
  P();
  P("| period | Cell | n | $/merged | min/merged | failed/claims | task-high - slow-high $ [range] | min [range] |");
  P("|---|---|---|---|---|---|---|---|");
  const a2 = allRows.filter((r) => r.K === 3 && r.session >= smolStart);
  for (const [name, rs] of [["A (K=3)", allRows.filter((r) => r.K === 3)], ["A2 (K=3, from first haiku-5-5 session)", a2], ["B (K=2)", allRows.filter((r) => r.K === 2)]]) {
    CELLS.forEach((c, i) => {
      const x = rs.filter((r) => r.cell === c);
      if (!x.length) return;
      const g = figs(x);
      const gap = c === "task-high" ? `${sgn2(gapPoint(rs, "task-high", "slow-high", "usd"))} ${rng(gapCI(rs, "task-high", "slow-high", "usd"))} | ${sgn1(gapPoint(rs, "task-high", "slow-high", "min"))} ${rng(gapCI(rs, "task-high", "slow-high", "min"), 1)}` : " | ";
      P(`| ${i === 0 ? name : ""} | ${c} | ${g.n} | ${f2(g.usd)} | ${f1(g.min)} | ${g.failed}/${g.claims} (${f1(g.fail)}%) | ${gap} |`);
    });
  }
}
perInputSection(pairPool, "2.1 task-high - slow-high", ["task-high", "slow-high"], { tag: "pair" });

P();
P("## 3. Per-input splits: smol-high vs slow-high, sub-period A2 only");
{
  const a2 = allRows.filter((r) => r.K === 3 && r.session >= smolStart);
  P();
  P(`A2 pool: ${a2.length} Pulls (${CELLS.map((c) => `${c} ${a2.filter((r) => r.cell === c).length}`).join(", ")}). smol-high has ${a2.filter((r) => r.cell === "smol-high").length} Pulls, so a median split leaves about half that on each side: only the sides listed under "Sides where both Cells" reach the Router's MIN_N of ${MIN_N}, and \`n\` is shown beside every figure so the reader can discount the rest.`);
  perInputSection(a2.filter((r) => r.cell !== "task-high"), "3.1 smol-high - slow-high (A2)", ["smol-high", "slow-high"], { tag: "a2" });
  perInputSection(a2.filter((r) => r.cell !== "smol-high"), "3.2 task-high - slow-high (A2, for comparison on the same Pulls)", ["task-high", "slow-high"], { tag: "a2" });
}

P();
P("## 4. Sensitivity: drop every Pull with an implementer row at a Cell other than the drawn one");
P();
P(`${resRows.length} of ${allRows.length} counted newest-generation Pulls are rescued (${pairPool.length - pairNoRescue.length} of the ${pairPool.length} slow/task ones). Per-Cell figures after the drop:`);
P();
P("| Cell | n | failed | $/merged | min/merged |");
P("|---|---|---|---|---|");
for (const c of CELLS) { const rs = allRows.filter((r) => r.cell === c && !r.rescued), g = figs(rs); P(`| ${c} | ${rs.length} | ${g.failed} | ${f2(g.usd)} | ${f1(g.min)} |`); }
perInputSection(pairNoRescue, "4.1 task-high - slow-high, rescued Pulls dropped", ["task-high", "slow-high"], { tag: "pair" });

// minN 20 is the Router's own floor (MIN_N); 10 is a looser sensitivity
P();
P("## 5. Grouping gain over one Cell, against a permutation null");
P();
P(`Routing value of a grouping: each group takes the Cell with the lowest figure per merged PR among the Cells with >= minN Pulls in that group that clear the quality floor against slow-high there; a group where no Cell qualifies takes the one-Cell choice. The value is the groups' Pull-share-weighted figure. The one-Cell baseline is the same rule over a single group, and a grouping's gain is that Cell's value minus the routed value, both over the grouping's own group shares, so a grouping that moves no group off the one-Cell choice gains exactly 0. Gains are in-sample unless the cross-validation section says otherwise.`);
gainSection(pairPool, ["slow-high", "task-high"], `5.1 slow-high vs task-high, minN = ${MIN_N} (the Router's MIN_N)`, MIN_N);
gainSection(pairPool, ["slow-high", "task-high"], "5.2 slow-high vs task-high, minN = 10 (looser)", 10);
gainSection(pairNoRescue, ["slow-high", "task-high"], `5.3 rescued Pulls dropped, minN = ${MIN_N}`, MIN_N);
{
  const a2 = allRows.filter((r) => r.K === 3 && r.session >= smolStart);
  gainSection(a2, CELLS, "5.4 all three Cells, sub-period A2, minN = 10 (smol-high has 32 Pulls in all)", 10);
}
P();
P("## 5.5 Cross-validation");
cvSection(pairPool, ["slow-high", "task-high"], MIN_N, `5.5.1 slow-high vs task-high, minN = ${MIN_N}`);
cvSection(pairPool, ["slow-high", "task-high"], 10, "5.5.2 slow-high vs task-high, minN = 10");

process.stdout.write(out.join("\n") + "\n");
