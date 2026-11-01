#!/usr/bin/env node
// Derivation script for issue #4156: why did fail rates fall between the two
// draw periods (K=3 up to session 2026-10-25T09-45, K=2 after it)?
//
// Every figure comes from the Router's own modules, imported from this
// checkout (plugin/scripts/): `attribute`, `generations`, `tally` and
// `parseFeatures` from pull-attribution.mjs, `parseTierOutcomes` and
// `isDerivedNote` from tier-outcomes.mjs, `parseTsv` from member-outcomes.mjs,
// `ruleStratum` from ticket-router.mjs. The Pull set, the window
// (2026-10-03), the Fit's filter and the per-Cell newest-generation counted
// Pulls are exactly docs/research/router-inputs-derive.mjs's (#4150); the
// period is each Pull's recorded K. A failure is a merged PR ruled
// `minted_false_claim=yes` or `closed_own_ticket=no` (`failsFloor`).
//
// What the Router's modules do not hold, this script reads from git: the
// version history of docs/metrics/tier-outcomes.tsv (`git log -p`), to tell a
// Ruling written at close-out from one re-ruled later and to read each Pull's
// FIRST Ruling; and the commit history of the review/Charges/ruling files since
// 2026-10-11. Release availability of those commits comes from the public npm
// registry document for @feigi/fleet-ctl (each version carries its `gitHead`
// and publish time), cached outside the repository.
//
// node docs/research/fail-rate-drift-derive.mjs [--cache DIR] [--iters N]
//                                               [--perms N] [--seed S] [--state DIR]
//   --cache DIR   cache for the npm registry document (default
//                 <os.tmpdir()>/fail-rate-drift-cache). Refused inside the
//                 repository. Fetched with `fetch` when missing; a failed
//                 fetch exits 1.
//   --iters N     bootstrap resamples (default 1000; IPW weights are refit on
//                 every resample).
//   --perms N     permutations for the period-mix tests (default 2000).
//   --seed S      RNG seed (default 20261101).
//   --state DIR   the main checkout's `.fleet` directory (outside the repo; the
//                 live run's state home). Optional: only fills the `pin`
//                 column of the per-session table from the phase-0 receipts.
// Zero dependencies beyond the repo's own modules; Node >= 18; needs `git`
// and, once, network. Stdout is markdown.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const S = path.join(ROOT, "plugin/scripts");
const { attribute, generations, tally, parseFeatures } = await import(`${S}/pull-attribution.mjs`);
const { parseTsv } = await import(`${S}/member-outcomes.mjs`);
const { parseTierOutcomes, isDerivedNote } = await import(`${S}/tier-outcomes.mjs`);
const { ruleStratum } = await import(`${S}/ticket-router.mjs`);

// ------------------------------------------------------------------ flags
const argv = process.argv.slice(2);
const flags = { cache: path.join(os.tmpdir(), "fail-rate-drift-cache"), iters: 1000, perms: 2000, seed: 20261101, state: null };
const die = (m) => { process.stderr.write(`fail-rate-drift-derive: ${m}\n`); process.exit(1); };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], v = () => (i + 1 < argv.length ? argv[++i] : die(`${a} needs a value`));
  if (a === "--cache") flags.cache = path.resolve(v());
  else if (a === "--iters") flags.iters = Number(v());
  else if (a === "--perms") flags.perms = Number(v());
  else if (a === "--seed") flags.seed = Number(v());
  else if (a === "--state") flags.state = path.resolve(v());
  else die(`unknown flag ${a}`);
}
if (!(flags.iters >= 200)) die("--iters must be at least 200");
if (!(flags.perms >= 200)) die("--perms must be at least 200");
if (!path.relative(ROOT, flags.cache).startsWith("..")) die(`--cache ${flags.cache} is inside the repository`);
fs.mkdirSync(flags.cache, { recursive: true });

// ------------------------------------------------------------------ helpers
const out = [];
const P = (s = "") => out.push(s);
const pct = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : `${(100 * x).toFixed(1)}%`);
const pp = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : `${x >= 0 ? "+" : ""}${(100 * x).toFixed(1)}`);
const rngp = (c) => (c === null ? "n/a" : `${(100 * c[0]).toFixed(1)}, ${(100 * c[1]).toFixed(1)}`);
const f1 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(1));
const f2 = (x) => (x === null || x === undefined || Number.isNaN(x) ? "-" : x.toFixed(2));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const quantile = (sorted, q) => { const k = (sorted.length - 1) * q, f = Math.floor(k), c = Math.min(f + 1, sorted.length - 1); return sorted[f] + (sorted[c] - sorted[f]) * (k - f); };
const sortedNum = (xs) => [...xs].sort((a, b) => a - b);
const median = (xs) => (xs.length ? quantile(sortedNum(xs), 0.5) : null);
const dayNum = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);

function mulberry32(seed) { // same generator as pull-attribution.mjs's
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(n, rand) {
  const p = Int32Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  return p;
}
const range95 = (xs) => {
  const ys = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (ys.length < xs.length / 2) return null;
  return [ys[Math.floor(0.025 * (ys.length - 1))], ys[Math.ceil(0.975 * (ys.length - 1))]];
};
const git = (...args) => { const r = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }); if (r.status !== 0) die(`git ${args.join(" ")} failed: ${r.stderr.trim()}`); return r.stdout; };

// ------------------------------------------------------------------ data
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const features = parseFeatures(read("docs/metrics/ticket-features.tsv"));
const members = parseTsv(read("docs/metrics/member-outcomes.tsv"));
const tierText = read("docs/metrics/tier-outcomes.tsv");
const verdicts = parseTierOutcomes(tierText);
const WINDOW = "2026-10-03";
const all = attribute({ features, members, tiers: verdicts, windowStart: WINDOW, stratum: ruleStratum });
const order = generations(all);
const units = all.filter((u) => u.pull.exploration_draw !== "" || u.pull.sizing_src === "rule");
const tallies = tally(units, order);
const gitHead = git("rev-parse", "--short", "HEAD").trim();
const kOf = (u) => Number(u.pull.exploration_draw.split("/")[1]);
const failsFloor = (r) => r.minted_false_claim === "yes" || r.closed_own_ticket === "no";
const CELLS = ["slow-high", "task-high"];
const PERIODS = ["A", "B"];
const sessionIso = (s) => s.replace(/^(\d{4}-\d{2}-\d{2})T(\d\d)-(\d\d)-(\d\d).*$/, "$1T$2:$3:$4Z");

// ------------------------------------------------------------------ tier-outcomes history
// Each PR's row versions, oldest first: the commit that added a row line.
const histOut = git("log", "--reverse", "-p", "--no-merges", "--format=@@@%h\t%ad\t%s", "--date=short", "--", "docs/metrics/tier-outcomes.tsv");
const hist = new Map(); // pr -> [{ sha, date, subject, row }]
{
  let cur = null;
  for (const l of histOut.split("\n")) {
    if (l.startsWith("@@@")) { const [sha, date, ...s] = l.slice(3).split("\t"); cur = { sha, date, subject: s.join("\t") }; continue; }
    if (!l.startsWith("+") || l.startsWith("+++")) continue;
    const line = l.slice(1);
    if (!/^\d{4}-\d{2}-\d{2}\t/.test(line)) continue;
    const row = parseTierOutcomes(line)[0];
    (hist.get(row.pr) ?? hist.set(row.pr, []).get(row.pr)).push({ ...cur, row });
  }
}
// The re-rule batches the file's header lists, by issue.
const RERULE_DATE = { 3831: "2026-10-26", 3832: "2026-10-27" };
for (const [iss, date] of Object.entries(RERULE_DATE)) {
  if (!new RegExp(`^# ${date} \\(#${iss}\\): \\d+ ROWS RE-RULED`, "m").test(tierText)) die(`header lacks the ${date} (#${iss}) re-rule batch`);
}

// ------------------------------------------------------------------ Pull rows
const pullRows = [];
for (const t of tallies) {
  if (!CELLS.includes(t.cell)) continue;
  for (const u of t.pulls) {
    if (!u.ruling) die(`counted Pull of ticket ${u.pull.ticket} has no Ruling`);
    const vs = hist.get(u.ruling.pr) ?? [];
    if (vs.length === 0) die(`PR ${u.ruling.pr} has no tier-outcomes history`);
    const final = vs.findLast((v) => v.row.line === u.ruling.line);
    if (!final) die(`PR ${u.ruling.pr}: the file's row is in no committed version`);
    const first = vs[0];
    const note = u.ruling.note;
    const rr = /re-ruled by #(\d+)/.exec(note)?.[1] ?? "";
    const prov = rr ? `R${rr}` : isDerivedNote(note) ? "E" : "H";
    const firstProv = isDerivedNote(first.row.note) ? "derived" : first.row.sizing === "" ? "hand, blank sizing" : "hand, sizing recorded";
    const f = u.pull;
    const ruleDate = rr ? RERULE_DATE[rr] : final.date;
    pullRows.push({
      u, cell: u.cell, per: kOf(u) === 3 ? "A" : "B", K: kOf(u), session: f.session, date: f.run_date, ticket: f.ticket, pr: u.ruling.pr,
      fail: failsFloor(u.ruling) ? 1 : 0,
      kindOfFail: u.ruling.minted_false_claim === "yes" && u.ruling.closed_own_ticket === "no" ? "both" : u.ruling.minted_false_claim === "yes" ? "false claim" : u.ruling.closed_own_ticket === "no" ? "unmet" : "",
      failFirst: failsFloor(first.row) ? 1 : 0,
      prov, firstProv, nvers: vs.length, finalSha: final.sha, finalCommitDate: final.date, ruleDate, stamped: u.ruling.run_date,
      lag: dayNum(ruleDate) - dayNum(f.run_date), firstSha: first.sha, firstDate: first.date, firstLag: dayNum(first.date) - dayNum(f.run_date),
      firstSizingBlank: first.row.sizing === "",
      // the recorded features, as the Router saw them at dispatch
      brief_chars: f.brief_chars === "" ? null : Number(f.brief_chars), criteria: f.criteria === "" ? null : Number(f.criteria),
      comments: f.comments === "" ? null : Number(f.comments), age_days: f.age_days === "" ? null : Number(f.age_days),
      paths: f.paths === "" ? null : Number(f.paths), test_paths: f.test_paths === "" ? null : Number(f.test_paths),
      xrefs: f.xrefs === "" ? null : Number(f.xrefs), kind: f.kind || "(none)", slice: f.parent !== "" ? "slice" : "no-slice",
      stratum: u.stratum,
    });
  }
}
const sel = (rows, cell, per) => rows.filter((r) => (cell === null || r.cell === cell) && (per === null || r.per === per));
const rate = (rows, key = "fail") => (rows.length ? sum(rows.map((r) => r[key])) / rows.length : null);
const gap = (cell, key = "fail") => rate(sel(pullRows, cell, "A"), key) - rate(sel(pullRows, cell, "B"), key);

// ================================================================== report
P("# fail-rate-drift derive output");
P();
P(`Repository HEAD ${gitHead}; window start ${WINDOW}; ${all.length} Pulls in the window, ${units.length} in the Fit's set; ${pullRows.length} counted newest-generation Pulls of ${CELLS.join(" and ")} (smol-high is drawn in period A only and is left out); seed ${flags.seed}; bootstrap ${flags.iters}; perms ${flags.perms}.`);
P();
P(`The Ruling of every one of these Pulls is the row \`attribute\` booked to it; \`claims\` = Pulls on every row (${sum(pullRows.map((r) => r.u.claims)) === pullRows.length ? "so a failure is exactly a failing Ruling: no `bail:fixed-refuted` ending is counted" : "NOTE: a bail:fixed-refuted ending adds a claim"}); \`falseClaims\` = failures (${sum(pullRows.map((r) => r.u.falseClaims)) === sum(pullRows.map((r) => r.fail)) ? "equals the Ruling-floor count" : "DIFFERS from the Ruling-floor count"}).`);

// ------------------------------------------------------------------ 1. rates
P();
P("## 1. Fail rate per Cell and period; failure kinds");
P();
P("Period A = recorded K 3 (slow, smol, task); B = K 2 (slow, task). Kinds: `false claim` = `minted_false_claim=yes` and `closed_own_ticket=yes`; `unmet` = `closed_own_ticket=no` and no false claim; `both` = both.");
P();
P("| Cell | period | Pulls | failures | fail rate | false claim | unmet | both | any false claim | any unmet |");
P("|---|---|---|---|---|---|---|---|---|---|");
for (const c of CELLS) for (const p of PERIODS) {
  const rs = sel(pullRows, c, p), k = (x) => rs.filter((r) => r.kindOfFail === x).length;
  P(`| ${c} | ${p} | ${rs.length} | ${sum(rs.map((r) => r.fail))} | ${pct(rate(rs))} | ${k("false claim")} | ${k("unmet")} | ${k("both")} | ${k("false claim") + k("both")} | ${k("unmet") + k("both")} |`);
}
for (const c of [...CELLS, null]) {
  const A = sel(pullRows, c, "A"), B = sel(pullRows, c, "B");
  const a = sum(A.map((r) => r.fail)), b = sum(B.map((r) => r.fail));
  P(`| ${c ?? "slow+task"} | A→B | ${A.length}→${B.length} | ${a}→${b} | ${pct(rate(A))}→${pct(rate(B))} (${pp(rate(B) - rate(A))} pp) | | | | | |`);
}

// ------------------------------------------------------------------ 2. the evidence-reclaim artefact
P();
P("## 2. How each Ruling was first written");
P();
P("Snapshots of the whole file as committed (`git show <sha>:docs/metrics/tier-outcomes.tsv`), rows split by `run_date` against 2026-10-15. The first snapshot is the file as the map #3673 note of 2026-10-21 saw it:");
P();
{
  const snaps = [["712d97ef", "10-21 morning: hand-written rows of the 10-18..10-20 close-outs"], ["f6793d2a", "10-21: backfill of 69 reviewed PRs"], ["f6c08ff0", "10-25: append works the Ruling out from the Charges"], ["7c98045c", "10-26: re-rule #3831 (21 rows)"], ["c3f0c6d1", "10-27: re-rule #3832 (180 rows)"], ["HEAD", "this checkout"]];
  P("| snapshot | what it is | rows run_date >= 10-15 | of those blank sizing | of those minted_false_claim=yes | rows run_date < 10-15 | of those minted_false_claim=yes |");
  P("|---|---|---|---|---|---|---|");
  for (const [sha, what] of snaps) {
    const rows = parseTierOutcomes(git("show", `${sha}:docs/metrics/tier-outcomes.tsv`));
    const a = rows.filter((r) => r.run_date >= "2026-10-15"), b = rows.filter((r) => r.run_date < "2026-10-15");
    P(`| ${sha === "HEAD" ? gitHead : sha} | ${what} | ${a.length} | ${a.filter((r) => r.sizing === "").length} | ${a.filter((r) => r.minted_false_claim === "yes").length} | ${b.length} | ${b.filter((r) => r.minted_false_claim === "yes").length} |`);
  }
}
P();
P("Every row of `docs/metrics/tier-outcomes.tsv` as FIRST committed (`git log -p`; a row later edited in place counts as first written), split by `run_date` (the date the controller stamped at ruling) against 2026-10-15:");
P();
{
  const firstRows = [...hist.values()].map((vs) => vs[0]);
  const bucket = (pred) => firstRows.filter(pred);
  const line = (name, rs) => `| ${name} | ${rs.length} | ${rs.filter((v) => isDerivedNote(v.row.note)).length} | ${rs.filter((v) => v.row.sizing === "").length} | ${rs.filter((v) => v.row.minted_false_claim === "yes").length} | ${rs.filter((v) => v.row.closed_own_ticket === "no").length} | ${rs.filter((v) => failsFloor(v.row)).length} |`;
  P("| first-committed row's run_date | rows | derived note | blank sizing | minted_false_claim=yes | closed_own_ticket=no | fails the floor |");
  P("|---|---|---|---|---|---|---|");
  P(line("< 2026-10-15", bucket((v) => v.row.run_date < "2026-10-15")));
  P(line(">= 2026-10-15", bucket((v) => v.row.run_date >= "2026-10-15")));
  P(line(">= 2026-10-15, note not derived", bucket((v) => v.row.run_date >= "2026-10-15" && !isDerivedNote(v.row.note))));
  P(line(">= 2026-10-15, note derived", bucket((v) => v.row.run_date >= "2026-10-15" && isDerivedNote(v.row.note))));
  P(line(">= 2026-10-03 (the window), note not derived", bucket((v) => v.row.run_date >= WINDOW && !isDerivedNote(v.row.note))));
}
P();
P("The Pulls above, by the commit that first wrote their Ruling (first version of the PR's row; `E` = never rewritten, `R` = a later version exists):");
P();
{
  const m = new Map();
  for (const r of pullRows) {
    const k = `${r.firstSha} ${r.firstDate} | ${r.firstProv}`;
    const x = m.get(k) ?? m.set(k, { n: 0, firstFail: 0, blank: 0, finalFail: 0, rewritten: 0 }).get(k);
    x.n++; x.firstFail += r.failFirst; x.blank += r.firstSizingBlank ? 1 : 0; x.finalFail += r.fail; x.rewritten += r.nvers > 1 ? 1 : 0;
  }
  P("| first-writing commit date | first note | Pulls | blank sizing at first writing | failing at first writing | failing now | rewritten since |");
  P("|---|---|---|---|---|---|---|");
  for (const [k, x] of [...m].sort((a, b) => (a[0].split(" ")[1] < b[0].split(" ")[1] ? -1 : a[0].split(" ")[1] > b[0].split(" ")[1] ? 1 : 0))) P(`| ${k.replace(" | ", " | ")} | ${x.n} | ${x.blank} | ${x.firstFail} | ${x.finalFail} | ${x.rewritten} |`);
}

// ------------------------------------------------------------------ 3. provenance of the Ruling in force
P();
P("## 3. Provenance of the Ruling the Router reads");
P();
P("Groups, from the row in force: **E** = note is a derived note and carries no re-rule suffix (written by `append` from the Charges at close-out, never rewritten as a re-rule); **R3831 / R3832** = note ends ` — re-ruled by #3831|#3832 from session …` (header batches dated 2026-10-26 and 2026-10-27); **H** = note not derived (by hand). `ruling date` = the commit date of the row's version in force, and for R rows the batch date the header gives (the `run_date` column of a re-ruled row keeps the ORIGINAL stamp). `lag` = ruling date minus the Pull's `run_date`, in days.");
P();
const GROUPS = ["E", "R3831", "R3832", "H"];
P("| Cell | period | group | Pulls | failing (in force) | fail rate | failing at first ruling | median lag d | min..max lag d | stamped run_date lag, median d |");
P("|---|---|---|---|---|---|---|---|---|---|");
for (const c of CELLS) for (const p of PERIODS) {
  for (const g of [...GROUPS, "all"]) {
    const rs = sel(pullRows, c, p).filter((r) => g === "all" || r.prov === g);
    if (!rs.length) continue;
    const lags = rs.map((r) => r.lag), st = rs.map((r) => dayNum(r.stamped) - dayNum(r.date));
    P(`| ${c} | ${p} | ${g} | ${rs.length} | ${sum(rs.map((r) => r.fail))} | ${pct(rate(rs))} | ${sum(rs.map((r) => r.failFirst))} | ${f1(median(lags))} | ${Math.min(...lags)}..${Math.max(...lags)} | ${f1(median(st))} |`);
  }
}
P();
P("Pooled over both Cells (slow-high + task-high):");
P();
P("| period | group | Pulls | failing | fail rate | share of period's Pulls |");
P("|---|---|---|---|---|---|");
for (const p of PERIODS) for (const g of [...GROUPS, "all"]) {
  const rs = sel(pullRows, null, p).filter((r) => g === "all" || r.prov === g);
  if (!rs.length) continue;
  P(`| ${p} | ${g} | ${rs.length} | ${sum(rs.map((r) => r.fail))} | ${pct(rate(rs))} | ${pct(rs.length / sel(pullRows, null, p).length)} |`);
}

// ------------------------------------------------------------------ 4. as first ruled
P();
P("## 4. The same Pulls as FIRST ruled, and what the re-rules changed");
P();
P("`first ruling` = the first committed version of the Pull's PR row. The three first-ruling provenances: `derived` (a derived note), `hand, blank sizing` (a non-derived note and a blank `sizing`: ruled without its evidence, the artefact), `hand, sizing recorded` (a non-derived note with `sizing`).");
P();
P("| Cell | period | first-ruling provenance | Pulls | failing at first ruling | fail rate at first ruling | failing now | fail rate now | pass→fail | fail→pass | median lag of first ruling, d |");
P("|---|---|---|---|---|---|---|---|---|---|---|");
for (const c of [...CELLS, null]) for (const p of PERIODS) {
  for (const g of ["derived", "hand, blank sizing", "hand, sizing recorded", "all"]) {
    const rs = sel(pullRows, c, p).filter((r) => g === "all" || r.firstProv === g);
    if (!rs.length) continue;
    P(`| ${c ?? "slow+task"} | ${p} | ${g} | ${rs.length} | ${sum(rs.map((r) => r.failFirst))} | ${pct(rate(rs, "failFirst"))} | ${sum(rs.map((r) => r.fail))} | ${pct(rate(rs))} | ${rs.filter((r) => !r.failFirst && r.fail).length} | ${rs.filter((r) => r.failFirst && !r.fail).length} | ${f1(median(rs.map((r) => r.firstLag)))} |`);
  }
}
P();
P("| Cell | fail rate A | B | drop (pp) — Rulings as first written | fail rate A | B | drop (pp) — Rulings in force |");
P("|---|---|---|---|---|---|---|");
for (const c of [...CELLS, null]) {
  const A = sel(pullRows, c, "A"), B = sel(pullRows, c, "B");
  P(`| ${c ?? "slow+task"} | ${pct(rate(A, "failFirst"))} | ${pct(rate(B, "failFirst"))} | ${pp(rate(A, "failFirst") - rate(B, "failFirst"))} | ${pct(rate(A))} | ${pct(rate(B))} | ${pp(rate(A) - rate(B))} |`);
}

// ------------------------------------------------------------------ 5. mix
P();
P("## 5. Ticket mix, period A against period B");
P();
P("The nine recorded metrics, as `ticket-features.tsv` holds them (what the Router saw at dispatch), over the counted slow-high + task-high Pulls (the draws inside a period are random between the Cells, so the Cells are pooled). Test: period labels permuted (seeded), statistic = |difference of mean ranks| (numeric) or chi-square (kind, Slice); p add-one.");
P();
const NUM = ["brief_chars", "criteria", "comments", "age_days", "paths", "test_paths", "xrefs"];
function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; }
  return r;
}
function permP(valuesA, valuesB, kind, rand) {
  const vals = [...valuesA, ...valuesB], nA = valuesA.length;
  let stat;
  if (kind === "num") {
    const rk = ranks(vals);
    stat = (lab) => { let a = 0, na = 0, b = 0, nb = 0; for (let i = 0; i < rk.length; i++) { if (lab[i]) { a += rk[i]; na++; } else { b += rk[i]; nb++; } } return Math.abs(a / na - b / nb); };
  } else {
    const cats = [...new Set(vals)].sort(), ci = vals.map((v) => cats.indexOf(v));
    stat = (lab) => { const o = [new Float64Array(cats.length), new Float64Array(cats.length)]; for (let i = 0; i < ci.length; i++) o[lab[i] ? 0 : 1][ci[i]]++; const rt = [sum(o[0]), sum(o[1])]; let x = 0; for (let c = 0; c < cats.length; c++) { const ct = o[0][c] + o[1][c]; for (const g of [0, 1]) { const e = rt[g] * ct / vals.length; if (e) x += (o[g][c] - e) ** 2 / e; } } return x; };
  }
  const lab0 = vals.map((_, i) => i < nA);
  const real = stat(lab0);
  let ge = 0;
  for (let it = 0; it < flags.perms; it++) { const pm = shuffled(vals.length, rand); if (stat(lab0.map((_, i) => lab0[pm[i]])) >= real - 1e-9) ge++; }
  return { real, p: (ge + 1) / (flags.perms + 1) };
}
{
  const rand = mulberry32(flags.seed + 11);
  const A = sel(pullRows, null, "A"), B = sel(pullRows, null, "B");
  P(`n: A ${A.length}, B ${B.length}.`);
  P();
  P("| feature | A median (p25..p75) | B median (p25..p75) | A mean | B mean | statistic | p |");
  P("|---|---|---|---|---|---|---|");
  const q = (rs, k) => { const xs = sortedNum(rs.map((r) => r[k]).filter((x) => x !== null)); return `${f1(quantile(xs, 0.5))} (${f1(quantile(xs, 0.25))}..${f1(quantile(xs, 0.75))})`; };
  const mn = (rs, k) => { const xs = rs.map((r) => r[k]).filter((x) => x !== null); return sum(xs) / xs.length; };
  for (const k of NUM) {
    const a = A.map((r) => r[k]).filter((x) => x !== null), b = B.map((r) => r[k]).filter((x) => x !== null);
    const t = permP(a, b, "num", rand);
    P(`| ${k} | ${q(A, k)} | ${q(B, k)} | ${f1(mn(A, k))} | ${f1(mn(B, k))} | ${f2(t.real)} | ${f2(t.p)} |`);
  }
  for (const k of ["kind", "slice"]) {
    const t = permP(A.map((r) => r[k]), B.map((r) => r[k]), "cat", rand);
    const cats = [...new Set([...A, ...B].map((r) => r[k]))].sort();
    P(`| ${k} | ${cats.map((c) => `${c} ${pct(A.filter((r) => r[k] === c).length / A.length)}`).join(", ")} | ${cats.map((c) => `${c} ${pct(B.filter((r) => r[k] === c).length / B.length)}`).join(", ")} | | | ${f2(t.real)} | ${f2(t.p)} |`);
  }
  {
    const cats = ["light", "heavy", "unknown"];
    const t = permP(A.map((r) => r.stratum), B.map((r) => r.stratum), "cat", rand);
    P(`| rule stratum (light/heavy, derived from the above) | ${cats.map((c) => `${c} ${pct(A.filter((r) => r.stratum === c).length / A.length)}`).join(", ")} | ${cats.map((c) => `${c} ${pct(B.filter((r) => r.stratum === c).length / B.length)}`).join(", ")} | | | ${f2(t.real)} | ${f2(t.p)} |`);
  }
  P();
  const nom = [];
  P(`blank recorded metrics: ${NUM.filter((k) => pullRows.some((r) => r[k] === null)).map((k) => `${k} ${pullRows.filter((r) => r[k] === null).length}`).join(", ") || "none"}.`);
  void nom;
}
P();
P("Does the ticket's mix predict failure? Fail rate by feature stratum, both periods pooled, Rulings in force:");
P();
{
  P("| stratum | Pulls | failing | fail rate |");
  P("|---|---|---|---|");
  const strata = (r) => `${r.kind} / ${r.slice} / ${r.stratum}`;
  const keys = [...new Set(pullRows.map(strata))].sort();
  for (const k of keys) { const rs = pullRows.filter((r) => strata(r) === k); P(`| ${k} | ${rs.length} | ${sum(rs.map((r) => r.fail))} | ${pct(rate(rs))} |`); }
  for (const k of NUM) {
    const xs = pullRows.map((r) => r[k]).filter((x) => x !== null), m = median(xs);
    const hi = pullRows.filter((r) => r[k] !== null && r[k] > m), lo = pullRows.filter((r) => r[k] !== null && r[k] <= m);
    P(`| ${k} > median ${f1(m)} | ${hi.length} | ${sum(hi.map((r) => r.fail))} | ${pct(rate(hi))} |`);
    P(`| ${k} <= median ${f1(m)} | ${lo.length} | ${sum(lo.map((r) => r.fail))} | ${pct(rate(lo))} |`);
  }
}

// ------------------------------------------------------------------ 6. reweighting
P();
P("## 6. Reweighting one period to the other's mix");
P();
P("Two weightings, both fit on the slow-high + task-high Pulls pooled (the Cells are drawn at random inside a period, so one mix per period) and applied to each Cell's Pulls:");
P();
P("- **strata**: kind (bug / enhancement / documentation / none) × Slice (`parent` set) × the rule's light/heavy (`ruleStratum`); a Pull of stratum s in the period being reweighted gets weight share_target(s) / share_source(s); a stratum absent from the target gets weight 0.");
P("- **IPW**: ridge-penalised (λ = 1) logistic regression of period (A = 1) on log1p of the seven numeric metrics (standardised), kind dummies and the Slice flag; a B Pull gets weight p/(1−p) (to A's mix), an A Pull (1−p)/p (to B's mix). Self-normalised; no trimming.");
P();
const BASE_FEATS = (r) => [...NUM.map((k) => Math.log1p(r[k] ?? 0)), r.kind === "bug" ? 1 : 0, r.kind === "enhancement" ? 1 : 0, r.kind === "documentation" ? 1 : 0, r.slice === "slice" ? 1 : 0];
function fitIPW(rowsA, rowsB) {
  const rows = [...rowsA, ...rowsB], y = rows.map((_, i) => (i < rowsA.length ? 1 : 0));
  const raw = rows.map(BASE_FEATS), d = raw[0].length;
  const mu = Array.from({ length: d }, (_, j) => sum(raw.map((x) => x[j])) / raw.length);
  const sd = Array.from({ length: d }, (_, j) => Math.sqrt(sum(raw.map((x) => (x[j] - mu[j]) ** 2)) / raw.length) || 1);
  const X = raw.map((x) => [1, ...x.map((v, j) => (v - mu[j]) / sd[j])]), D = d + 1, lambda = 1;
  let b = new Array(D).fill(0);
  for (let it = 0; it < 30; it++) {
    const pr = X.map((x) => 1 / (1 + Math.exp(-sum(x.map((v, j) => v * b[j])))));
    const g = new Array(D).fill(0), H = Array.from({ length: D }, () => new Array(D).fill(0));
    X.forEach((x, i) => { const w = pr[i] * (1 - pr[i]); for (let j = 0; j < D; j++) { g[j] += (y[i] - pr[i]) * x[j]; for (let k = 0; k < D; k++) H[j][k] += w * x[j] * x[k]; } });
    for (let j = 1; j < D; j++) { g[j] -= lambda * b[j]; H[j][j] += lambda; }
    H[0][0] += 1e-9;
    // solve H step = g by Gaussian elimination
    const M = H.map((row, j) => [...row, g[j]]);
    for (let c = 0; c < D; c++) { let p = c; for (let r = c + 1; r < D; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r; [M[c], M[p]] = [M[p], M[c]]; for (let r = c + 1; r < D; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= D; k++) M[r][k] -= f * M[c][k]; } }
    const step = new Array(D).fill(0);
    for (let r = D - 1; r >= 0; r--) { let s = M[r][D]; for (let k = r + 1; k < D; k++) s -= M[r][k] * step[k]; step[r] = s / M[r][r]; }
    b = b.map((v, j) => v + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return (r) => { const x = BASE_FEATS(r); const z = b[0] + sum(x.map((v, j) => b[j + 1] * (v - mu[j]) / sd[j])); return 1 / (1 + Math.exp(-z)); };
}
const stratumKey = (r) => `${r.kind} / ${r.slice} / ${r.stratum}`;
/** weights for `rows` of period `from` toward period `to`'s mix, given both periods' pooled rows. */
function weigh(method, from, rowsFrom, rowsTo, pooledA, pooledB) {
  if (method === "strata") {
    const cf = new Map(), ct = new Map();
    for (const r of rowsFrom) cf.set(stratumKey(r), (cf.get(stratumKey(r)) ?? 0) + 1);
    for (const r of rowsTo) ct.set(stratumKey(r), (ct.get(stratumKey(r)) ?? 0) + 1);
    return (r) => ((ct.get(stratumKey(r)) ?? 0) / rowsTo.length) / ((cf.get(stratumKey(r)) ?? 0) / rowsFrom.length);
  }
  const p = fitIPW(pooledA, pooledB);
  return from === "B" ? (r) => p(r) / (1 - p(r)) : (r) => (1 - p(r)) / p(r);
}
const wrate = (rows, w, key) => { const W = sum(rows.map(w)); return W ? sum(rows.map((r) => w(r) * r[key])) / W : null; };
const ess = (rows, w) => { const ws = rows.map(w); return sum(ws) ** 2 / sum(ws.map((x) => x * x)); };
/** all figures of one (re)sample: arrays of rows per Cell and period. */
function figures(smp, method, key) {
  const pooledA = [...smp["slow-high"].A, ...smp["task-high"].A], pooledB = [...smp["slow-high"].B, ...smp["task-high"].B];
  const wBtoA = weigh(method, "B", pooledB, pooledA, pooledA, pooledB), wAtoB = weigh(method, "A", pooledA, pooledB, pooledA, pooledB);
  const o = {};
  for (const c of [...CELLS, "pooled"]) {
    const A = c === "pooled" ? pooledA : smp[c].A, B = c === "pooled" ? pooledB : smp[c].B;
    o[c] = { rA: rate(A, key), rB: rate(B, key), BatoA: wrate(B, wBtoA, key), AtoB: wrate(A, wAtoB, key), essB: ess(B, wBtoA), essA: ess(A, wAtoB) };
    o[c].gapRaw = o[c].rA - o[c].rB; o[c].gapB2A = o[c].rA - o[c].BatoA; o[c].gapA2B = o[c].AtoB - o[c].rB;
    o[c].shareLeftB2A = o[c].gapB2A / o[c].gapRaw; o[c].shareLeftA2B = o[c].gapA2B / o[c].gapRaw;
    // group contributions to each rate (E, R, H pooled over R3831/R3832)
    for (const g of ["E", "R", "H"]) {
      const inG = (r) => (g === "R" ? r.prov.startsWith("R") : r.prov === g);
      o[c][`a_${g}`] = sum(A.filter(inG).map((r) => r[key])) / A.length;
      o[c][`b_${g}`] = sum(B.filter(inG).map((r) => r[key])) / B.length;
      const WB = sum(B.map(wBtoA));
      o[c][`bw_${g}`] = sum(B.filter(inG).map((r) => wBtoA(r) * r[key])) / WB;
    }
  }
  return o;
}
function bootFigures(method, key, seedOffset) {
  const rand = mulberry32(flags.seed + seedOffset);
  const base = Object.fromEntries(CELLS.map((c) => [c, { A: sel(pullRows, c, "A"), B: sel(pullRows, c, "B") }]));
  const point = figures(base, method, key);
  const draws = [];
  for (let it = 0; it < flags.iters; it++) {
    const smp = {};
    for (const c of CELLS) smp[c] = { A: Array.from({ length: base[c].A.length }, () => base[c].A[Math.floor(rand() * base[c].A.length)]), B: Array.from({ length: base[c].B.length }, () => base[c].B[Math.floor(rand() * base[c].B.length)]) };
    draws.push(figures(smp, method, key));
  }
  const rg = (c, f) => range95(draws.map((d) => d[c][f]));
  return { point, rg };
}
const results = {};
for (const method of ["strata", "ipw"]) results[method] = bootFigures(method, "fail", method === "strata" ? 100 : 200);

P("Coverage: B Pulls in a stratum with no A Pull, and A Pulls in a stratum with no B Pull (strata weighting gives them weight 0):");
P();
{
  const A = sel(pullRows, null, "A"), B = sel(pullRows, null, "B");
  const ka = new Set(A.map(stratumKey)), kb = new Set(B.map(stratumKey));
  P(`B Pulls in a stratum absent from A: ${B.filter((r) => !ka.has(stratumKey(r))).length} of ${B.length}; A Pulls in a stratum absent from B: ${A.filter((r) => !kb.has(stratumKey(r))).length} of ${A.length}. ${new Set([...ka, ...kb]).size} strata in all.`);
  P();
  P("| stratum (kind / Slice / light-heavy) | A Pulls | B Pulls | A share | B share |");
  P("|---|---|---|---|---|");
  for (const k of [...new Set([...ka, ...kb])].sort()) { const a = A.filter((r) => stratumKey(r) === k).length, b = B.filter((r) => stratumKey(r) === k).length; P(`| ${k} | ${a} | ${b} | ${pct(a / A.length)} | ${pct(b / B.length)} |`); }
}
P();
P("Reweighted fail rate (Rulings in force). `B→A` = period B's Pulls weighted to A's mix; `A→B` = period A's Pulls weighted to B's mix. Ranges are 95% bootstrap ranges (resampling Pulls within each Cell and period, weights refit on every resample), in percentage points / percent. `drop left` = (A − B reweighted to A's mix) ÷ (A − B) — the share of the observed drop that stays when the mix difference is removed; the second variant moves A instead of B.");
P();
P("| Cell | method | A rate | B rate | observed drop (pp) | B→A rate [range] | drop left after B→A (pp) [range] | share of drop left | A→B rate [range] | drop left after A→B (pp) [range] | share left | ESS of B→A / A→B |");
P("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const method of ["strata", "ipw"]) for (const c of [...CELLS, "pooled"]) {
  const { point, rg } = results[method], p = point[c];
  P(`| ${c} | ${method} | ${pct(p.rA)} | ${pct(p.rB)} | ${pp(p.gapRaw)} [${rngp(rg(c, "gapRaw"))}] | ${pct(p.BatoA)} [${rngp(rg(c, "BatoA"))}] | ${pp(p.gapB2A)} [${rngp(rg(c, "gapB2A"))}] | ${pct(p.shareLeftB2A)} | ${pct(p.AtoB)} [${rngp(rg(c, "AtoB"))}] | ${pp(p.gapA2B)} [${rngp(rg(c, "gapA2B"))}] | ${pct(p.shareLeftA2B)} | ${f1(p.essB)} / ${f1(p.essA)} |`);
}

// Same, on the Rulings as first written
P();
P("The same reweighting on the Rulings **as first written** (`failFirst`):");
P();
const resultsFirst = {};
for (const method of ["strata", "ipw"]) resultsFirst[method] = bootFigures(method, "failFirst", method === "strata" ? 300 : 400);
P("| Cell | method | A rate | B rate | observed drop (pp) | B→A rate [range] | drop left after B→A (pp) [range] | share left |");
P("|---|---|---|---|---|---|---|---|");
for (const method of ["strata", "ipw"]) for (const c of [...CELLS, "pooled"]) {
  const { point, rg } = resultsFirst[method], p = point[c];
  P(`| ${c} | ${method} | ${pct(p.rA)} | ${pct(p.rB)} | ${pp(p.gapRaw)} [${rngp(rg(c, "gapRaw"))}] | ${pct(p.BatoA)} [${rngp(rg(c, "BatoA"))}] | ${pp(p.gapB2A)} [${rngp(rg(c, "gapB2A"))}] | ${pct(p.shareLeftB2A)} |`);
}

// ------------------------------------------------------------------ 7. decomposition by provenance
P();
P("## 7. How much of each Cell's drop falls inside Rulings of each provenance");
P();
P("Rate = Σ over groups of (failing Pulls in the group ÷ the period's Pulls). A group's **contribution to the drop** = its contribution to A's rate − its contribution to B's rate; the contributions sum to the observed drop. A group's within-group rate is in § 3. `R` = R3831 + R3832. The `B→A strata/IPW` columns give B's contributions with B reweighted to A's mix first (weights as in § 6), so they sum to the drop left after the mix is removed.");
P();
P("| Cell | group | A: Pulls | A: failing | B: Pulls | B: failing | A contribution (pp) | B contribution (pp) | contribution to drop (pp) | share of drop | after B→A strata: contribution (pp) | after B→A IPW: contribution (pp) |");
P("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const c of [...CELLS, "pooled"]) {
  const p0 = results.strata.point[c], p1 = results.ipw.point[c];
  for (const g of ["E", "R", "H"]) {
    const inG = (r) => (g === "R" ? r.prov.startsWith("R") : r.prov === g);
    const A = sel(pullRows, c === "pooled" ? null : c, "A").filter(inG), B = sel(pullRows, c === "pooled" ? null : c, "B").filter(inG);
    const d = p0[`a_${g}`] - p0[`b_${g}`];
    P(`| ${c} | ${g} | ${A.length} | ${sum(A.map((r) => r.fail))} | ${B.length} | ${sum(B.map((r) => r.fail))} | ${pp(p0[`a_${g}`])} | ${pp(p0[`b_${g}`])} | ${pp(d)} | ${pct(d / p0.gapRaw)} | ${pp(p0[`a_${g}`] - p0[`bw_${g}`])} | ${pp(p1[`a_${g}`] - p1[`bw_${g}`])} |`);
  }
  P(`| ${c} | total | | | | | ${pp(p0.rA)} | ${pp(p0.rB)} | ${pp(p0.gapRaw)} | 100.0% | ${pp(p0.gapB2A)} | ${pp(p1.gapB2A)} |`);
}
P();
P("Within one provenance group, A against B (rate difference in pp; 95% bootstrap range over Pulls; raw, then B reweighted to A's stratum mix inside the group). `R` pools both re-rule batches.");
P();
P("| Cell | group | A rate (n) | B rate (n) | A − B raw (pp) [range] | A − B with B at A's mix, strata within the group (pp) [range] |");
P("|---|---|---|---|---|---|");
{
  const rand = mulberry32(flags.seed + 500);
  for (const c of [...CELLS, "pooled"]) for (const g of ["E", "R"]) {
    const inG = (r) => (g === "R" ? r.prov.startsWith("R") : r.prov === g);
    const A = sel(pullRows, c === "pooled" ? null : c, "A").filter(inG), B = sel(pullRows, c === "pooled" ? null : c, "B").filter(inG);
    if (A.length < 3 || B.length < 3) { P(`| ${c} | ${g} | ${pct(rate(A))} (${A.length}) | ${pct(rate(B))} (${B.length}) | too few Pulls | |`); continue; }
    const one = (a, b) => { const w = weigh("strata", "B", b, a); const raw = rate(a) - rate(b); const rw = rate(a) - wrate(b, w, "fail"); return [raw, rw]; };
    const [raw, rw] = one(A, B);
    const rs = [];
    for (let it = 0; it < flags.iters; it++) { const a = Array.from({ length: A.length }, () => A[Math.floor(rand() * A.length)]), b = Array.from({ length: B.length }, () => B[Math.floor(rand() * B.length)]); rs.push(one(a, b)); }
    P(`| ${c} | ${g} | ${pct(rate(A))} (${A.length}) | ${pct(rate(B))} (${B.length}) | ${pp(raw)} [${rngp(range95(rs.map((x) => x[0])))}] | ${pp(rw)} [${rngp(range95(rs.map((x) => x[1])))}] |`);
  }
}
P();
P("Inside period B, the same Cell's rate by provenance (the B-period Rulings differ in how they were made, and in WHEN: R rows are Pulls of sessions before the 2026-10-25 derivation; E rows after it):");
P();
P("| Cell | group | B Pulls | failing | rate | first session | last session |");
P("|---|---|---|---|---|---|---|");
for (const c of [...CELLS, null]) for (const g of ["E", "R"]) {
  const rs = sel(pullRows, c, "B").filter((r) => (g === "R" ? r.prov.startsWith("R") : r.prov === g));
  if (!rs.length) continue;
  const ss = rs.map((r) => r.session).sort();
  P(`| ${c ?? "slow+task"} | ${g} | ${rs.length} | ${sum(rs.map((r) => r.fail))} | ${pct(rate(rs))} | ${ss[0].slice(0, 16)} | ${ss.at(-1).slice(0, 16)} |`);
}
{
  const rand = mulberry32(flags.seed + 600);
  const R = sel(pullRows, null, "B").filter((r) => r.prov.startsWith("R")), E = sel(pullRows, null, "B").filter((r) => r.prov === "E");
  const ds = [];
  for (let it = 0; it < flags.iters; it++) { const a = Array.from({ length: R.length }, () => R[Math.floor(rand() * R.length)]), b = Array.from({ length: E.length }, () => E[Math.floor(rand() * E.length)]); ds.push(rate(a) - rate(b)); }
  P();
  P(`Period B, slow-high + task-high: re-ruled minus close-out-derived fail rate ${pp(rate(R) - rate(E))} pp [${rngp(range95(ds))}] (R ${R.length} Pulls, E ${E.length} Pulls; bootstrap over Pulls).`);
}

// ------------------------------------------------------------------ 8. calendar
P();
P("## 8. Calendar view: the same Pulls by session date, split by K");
P();
P("Period B's first session (2026-10-22T08-03) opens before period A's last (2026-10-25T09-45), so the two K values were drawn concurrently over a stretch. Fail rate (Rulings in force, then as first written), slow-high + task-high pooled, by the date of the Pull's session:");
P();
{
  const buckets = [["10-11..10-17", "2026-10-11", "2026-10-17"], ["10-18..10-21", "2026-10-18", "2026-10-21"], ["10-22..10-25", "2026-10-22", "2026-10-25"], ["10-26..10-30", "2026-10-26", "2026-10-30"]];
  P("| session dates | K | Pulls | failing | fail rate | rate as first written | E | R | H |");
  P("|---|---|---|---|---|---|---|---|---|");
  for (const [name, lo, hi] of buckets) for (const p of PERIODS) {
    const rs = sel(pullRows, null, p).filter((r) => r.session.slice(0, 10) >= lo && r.session.slice(0, 10) <= hi);
    if (!rs.length) continue;
    P(`| ${name} | ${p === "A" ? 3 : 2} | ${rs.length} | ${sum(rs.map((r) => r.fail))} | ${pct(rate(rs))} | ${pct(rate(rs, "failFirst"))} | ${rs.filter((r) => r.prov === "E").length} | ${rs.filter((r) => r.prov.startsWith("R")).length} | ${rs.filter((r) => r.prov === "H").length} |`);
  }
  const ov = (p) => sel(pullRows, null, p).filter((r) => r.session >= "2026-10-22T08-03" && r.session <= "2026-10-25T09-45~");
  P();
  P(`Overlap stretch, sessions 2026-10-22T08-03 .. 2026-10-25T09-45 (both K drawn): K=3 ${ov("A").length} Pulls, ${sum(ov("A").map((r) => r.fail))} failing (${pct(rate(ov("A")))}); K=2 ${ov("B").length} Pulls, ${sum(ov("B").map((r) => r.fail))} failing (${pct(rate(ov("B")))}).`);
  const sessions = (p) => new Set(sel(pullRows, null, p).map((r) => r.session.slice(0, 16)));
  const both = [...sessions("A")].filter((s) => sessions("B").has(s));
  P(`Sessions (to the minute) with Pulls of both K: ${both.length}${both.length ? ` (${both.join(", ")})` : ""}.`);
}

// ------------------------------------------------------------------ 8b. sessions
P();
P("### Per session");
P();
P(`A session is the unit the install, the controller state and the reviewers' behaviour are shared in, so Pulls of one session are not independent. The Fit's window holds ${new Set(pullRows.map((r) => r.session)).size} sessions with slow-high/task-high Pulls. \`pin\` = the \`instruments pinned: … (version X)\` line of the run's phase-0 receipt (\`.fleet/phase0.<UTC stamp>.json\`, written within two minutes after the session's start)${flags.state ? `, read from ${flags.state}` : "; NOT READ — rerun with --state <the main checkout's .fleet directory> to fill this column"}.`);
P();
P("| session start (UTC) | K | Pulls | failing | fail rate | rate as first written | E / R / H | pin |");
P("|---|---|---|---|---|---|---|---|");
const bySession = new Map();
for (const r of pullRows) (bySession.get(r.session) ?? bySession.set(r.session, []).get(r.session)).push(r);
const pinOf = (sessionKey) => {
  if (!flags.state) return "not read";
  const start = Date.parse(sessionIso(sessionKey));
  for (const f of fs.readdirSync(flags.state)) {
    const m = /^phase0\.(\d{4}-\d{2}-\d{2})T(\d\d)(\d\d)(\d\d)Z\.json$/.exec(f);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
    if (t - start < 0 || t - start > 120000) continue;
    const text = fs.readFileSync(path.join(flags.state, f), "utf8");
    const v = /instruments pinned: [^"]*\(version ([^)]+)\)/.exec(text);
    return v ? `${v[1]} (${f})` : `no version line (${f})`;
  }
  return "no receipt";
};
for (const [s, rs] of [...bySession].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  P(`| ${sessionIso(s)} | ${rs[0].K} | ${rs.length} | ${sum(rs.map((r) => r.fail))} | ${pct(rate(rs))} | ${pct(rate(rs, "failFirst"))} | ${rs.filter((r) => r.prov === "E").length} / ${rs.filter((r) => r.prov.startsWith("R")).length} / ${rs.filter((r) => r.prov === "H").length} | ${pinOf(s)} |`);
}
P();
P(`Cluster bootstrap: whole sessions resampled with replacement inside each period (${[...bySession.values()].filter((x) => x[0].per === "A").length} A sessions, ${[...bySession.values()].filter((x) => x[0].per === "B").length} B sessions), ${flags.iters} resamples; the 95% range of the fail-rate drop A − B, in pp. \`R only\` restricts both periods to re-ruled Pulls.`);
P();
P("| Pulls | drop A − B (pp) | cluster 95% range | Pull-level 95% range (§ 6) |");
P("|---|---|---|---|");
{
  const rand = mulberry32(flags.seed + 700);
  const sessA = [...bySession.values()].filter((x) => x[0].per === "A"), sessB = [...bySession.values()].filter((x) => x[0].per === "B");
  const sets = [["slow-high", (r) => r.cell === "slow-high"], ["task-high", (r) => r.cell === "task-high"], ["slow+task", () => true], ["slow+task, R only", (r) => r.prov.startsWith("R")]];
  for (const [name, keep] of sets) {
    const one = (sa, sb) => { const a = sa.flat().filter(keep), b = sb.flat().filter(keep); return a.length && b.length ? rate(a) - rate(b) : null; };
    const ds = [];
    for (let it = 0; it < flags.iters; it++) ds.push(one(Array.from({ length: sessA.length }, () => sessA[Math.floor(rand() * sessA.length)]), Array.from({ length: sessB.length }, () => sessB[Math.floor(rand() * sessB.length)])));
    const pl = name === "slow+task, R only" ? "n/a" : `[${rngp(results.strata.rg(name === "slow+task" ? "pooled" : name, "gapRaw"))}]`;
    P(`| ${name} | ${pp(one(sessA, sessB))} | [${rngp(range95(ds))}] | ${pl} |`);
  }
}

// ------------------------------------------------------------------ 9. commits
P();
P("## 9. Review, Charges and ruling commits, 2026-10-11 .. 2026-10-30");
P();
const PATHSPEC = [
  "plugin/scripts/tier-outcomes.mjs", "plugin/scripts/review-core.mjs", "plugin/agents/fleet-review-*", "plugin/skills/run-team/references/reviewers.md", "plugin/commands/review-and-fix.md",
  "plugin/scripts/dispositions-check.mjs", "plugin/agents/fleet-fix-applier.agent.md", "plugin/skills/run-team/briefs/fix-applier.md", "plugin/scripts/reclaim-scratch.mjs", "plugin/scripts/closeout.mjs", "plugin/scripts/diff-stats.mjs",
];
const EXTRA = [["e335b127", "plugin/scripts/fleet-tick.mjs (reap and reclaim once per merge pass)"]]; // the tick's reclaim call; fleet-tick.mjs is too large to pathspec wholesale
const CAT = (f) => (f === "plugin/scripts/tier-outcomes.mjs" ? "ruling" : /^plugin\/(scripts\/review-core\.mjs|agents\/fleet-review-|skills\/run-team\/references\/reviewers\.md|commands\/review-and-fix\.md)/.test(f) ? "review" : /^plugin\/(scripts\/dispositions-check\.mjs|agents\/fleet-fix-applier|skills\/run-team\/briefs\/fix-applier)/.test(f) ? "charges" : f === "plugin/scripts/reclaim-scratch.mjs" ? "evidence" : "other");
const logOut = git("log", "--since=2026-10-11", "--until=2026-10-31", "--no-merges", "--reverse", "--format=@%H|%h|%ad|%s", "--date=short", "--name-only", "--", ...PATHSPEC);
const commits = [];
for (const l of logOut.split("\n")) {
  if (l.startsWith("@")) { const [full, sha, date, ...s] = l.slice(1).split("|"); commits.push({ full, sha, date, subject: s.join("|"), files: [] }); } else if (l.trim() && commits.length) commits.at(-1).files.push(l.trim());
}
for (const [sha, why] of EXTRA) {
  const full = git("rev-parse", sha).trim(), date = git("log", "-1", "--format=%ad", "--date=short", full).trim(), subject = git("log", "-1", "--format=%s", full).trim();
  commits.push({ full, sha: full.slice(0, 8), date, subject, files: [why] });
}
commits.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
for (const c of commits) c.cats = [...new Set(c.files.map((f) => (f.includes("fleet-tick") ? "evidence" : CAT(f))))];
const kept = commits.filter((c) => c.cats.some((x) => x !== "other"));

// npm registry: each release's gitHead and publish time
const regFile = path.join(flags.cache, "registry.json");
if (!fs.existsSync(regFile) || fs.statSync(regFile).size === 0) {
  const res = await fetch("https://registry.npmjs.org/@feigi%2ffleet-ctl");
  if (!res.ok) die(`registry fetch failed: ${res.status}`);
  fs.writeFileSync(regFile, await res.text());
}
const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
const releases = Object.keys(reg.versions).filter((v) => reg.versions[v].gitHead && reg.time[v]).map((v) => ({ v, t: reg.time[v], head: reg.versions[v].gitHead })).sort((a, b) => (a.t < b.t ? -1 : 1));
const have = new Set(spawnSync("git", ["-C", ROOT, "cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: releases.map((r) => `${r.head}^{commit}`).join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 26 }).stdout.split("\n").filter((l) => l.endsWith(" commit")).map((l) => l.split(" ")[0]));
const rel = releases.filter((r) => have.has(r.head));
const isAnc = (a, b) => spawnSync("git", ["-C", ROOT, "merge-base", "--is-ancestor", a, b]).status === 0;
function firstRelease(full) { // releases come off main in time order, so "contains the commit" is monotone in time
  let lo = 0, hi = rel.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (isAnc(full, rel[mid].head)) hi = mid; else lo = mid + 1; }
  return rel[lo] ?? null;
}
const sessionStart = (r) => sessionIso(r.session);
const periodRows = { A: sel(pullRows, null, "A"), B: sel(pullRows, null, "B") };
const firstSess = (p) => periodRows[p].map(sessionStart).sort()[0], lastSess = (p) => periodRows[p].map(sessionStart).sort().at(-1);
P(`\`git log --since=2026-10-11 --until=2026-10-31 --no-merges\` over: ${PATHSPEC.join(", ")}; ${commits.length - EXTRA.length} commits, of which ${commits.length - EXTRA.length - (kept.length - EXTRA.length)} touched only closeout.mjs and/or diff-stats.mjs and are left out (they neither review nor charge nor rule), plus the ${EXTRA.length} named commit \`${EXTRA[0][0]}\` (the tick's reclaim, whose file is not pathspecced). Categories: \`ruling\` = tier-outcomes.mjs; \`review\` = review-core.mjs, fleet-review-* agents, reviewers.md, review-and-fix.md; \`charges\` = dispositions-check.mjs, the fix-applier agent and brief; \`evidence\` = reclaim-scratch.mjs and the tick's reclaim.`);
P();
P(`Availability. Each commit's **first npm release** is the earliest published @feigi/fleet-ctl version whose recorded \`gitHead\` has the commit as an ancestor (${rel.length} releases carry a gitHead present in this checkout; first ${rel[0].t}, last ${rel.at(-1).t}). The fleet executes an installed package (instruments.sh header), so a commit can only have run in a session that began after its first release was published. \`A after\` / \`B after\` = Pulls (slow+task, counted) of that period whose session started after that time, of ${periodRows.A.length} A and ${periodRows.B.length} B. Period A's sessions run ${firstSess("A")} .. ${lastSess("A")}; period B's ${firstSess("B")} .. ${lastSess("B")}. **Which installed version ran a given session is not recorded in the repository or in the run's phase-0 receipts before 2026-10-30T08:35** (see the note), so \`after\` is an upper bound: the maintainer may have kept an older install.`);
P();
P("| date | sha | categories | commit subject (effect as the subject states it) | first release (published UTC) | A after | B after |");
P("|---|---|---|---|---|---|---|");
for (const c of kept) {
  const r = firstRelease(c.full);
  const after = (p) => (r ? periodRows[p].filter((x) => sessionStart(x) > r.t).length : 0);
  P(`| ${c.date} | ${c.sha} | ${c.cats.join("+")} | ${c.subject.replace(/\|/g, "/").slice(0, 150)} | ${r ? `${r.v} (${r.t.slice(0, 16)})` : "unreleased"} | ${after("A")} | ${after("B")} |`);
}
P();
P(`Releases published inside period spans: between ${firstSess("A")} and ${lastSess("A")}: ${rel.filter((r) => r.t >= firstSess("A") && r.t <= lastSess("A")).length}; between ${firstSess("B")} and ${lastSess("B")}: ${rel.filter((r) => r.t >= firstSess("B") && r.t <= lastSess("B")).length}. Latest release published before period B's first session: ${[...rel].reverse().find((r) => r.t < firstSess("B"))?.v ?? "none"}; before period A's first: ${[...rel].reverse().find((r) => r.t < firstSess("A"))?.v ?? "none"}.`);

P();
P("## 10. Fail rate before and after each release, all counted slow-high + task-high Pulls");
P();
P("For the commits whose subject changes what review flags, what a member runs before push, what is charged, how the Ruling is worked out or whether the evidence survives. A Pull is `after` when its session started after the commit's first release (§ 9). Descriptive only: release time is confounded with calendar time, and with every other change released alongside it.");
P();
P("| sha | change | first release | before: Pulls / failing / rate | after: Pulls / failing / rate | before, period A only | after, period A only |");
P("|---|---|---|---|---|---|---|");
for (const [sha, what] of [["e335b127", "tick reclaims scratch after every merge pass"], ["159a6230", "reclaim-scratch.mjs; review snapshot prune becomes reclaim --pr"], ["ba59281f", "sizing read from report file (reclaim removes report files)"], ["357dccac", "Install step in the review snapshot"], ["e2dd20f6", "snapshot reads the Recipe's uncovered steps"], ["d2ef528d", "tests dimension kept for production diff with source and no test file"], ["7c2a85db", "Recipe Check step: members run CI's non-test checks"], ["d694ecba", "settle refuses a report with no green Check-step record"], ["849f7bd5", "members compare HEAD^{tree} with their Check-step record"], ["30ca2128", "comments dimension checks PR body and commit messages"], ["37fb07f2", "Charge required on the record answering a first review"], ["f6c08ff0", "append works the Ruling out from the Charges"]]) {
  const full = git("rev-parse", sha).trim(), r = firstRelease(full);
  if (!r) { P(`| ${sha} | ${what} | unreleased | | | | |`); continue; }
  const bef = pullRows.filter((x) => sessionStart(x) <= r.t), aft = pullRows.filter((x) => sessionStart(x) > r.t);
  const befA = bef.filter((x) => x.per === "A"), aftA = aft.filter((x) => x.per === "A");
  const cell = (rs) => (rs.length ? `${rs.length} / ${sum(rs.map((x) => x.fail))} / ${pct(rate(rs))}` : "0");
  P(`| ${sha} | ${what} | ${r.v} (${r.t.slice(0, 16)}) | ${cell(bef)} | ${cell(aft)} | ${cell(befA)} | ${cell(aftA)} |`);
}

console.log(out.join("\n"));
