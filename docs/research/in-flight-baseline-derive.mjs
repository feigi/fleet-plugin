#!/usr/bin/env node
// Derivation script for issue #2871 (map #2870): baseline the flow signals the
// In-flight bound's guard will be measured against — in-flight depth, cycle
// time, throughput, and the `ready-to-merge` label timings — over the N most
// recently created merged PRs of a GitHub repo, read off GitHub only (never off
// a session's transcripts, which do not travel).
//
// Zero dependencies. Node >= 18. Shells out to `gh api` when `gh auth status`
// succeeds, else to `curl` (honouring GITHUB_TOKEN when set and valid). Node's
// own fetch is deliberately not used: it does not honour HTTPS_PROXY.
//
//   node docs/research/in-flight-baseline-derive.mjs [flags]
//
//   --repo owner/name     repo to read (default feigi/fleet-plugin)
//   --n N                 population size: the N most recently CREATED merged
//                         PRs (default 400). With --after: the first N merged
//                         PRs created at or after that instant. `--n all` (only
//                         with --after) takes every merged PR since the instant.
//   --after ISO           cutover instant (e.g. 2026-10-12T00:00:00Z): the
//                         population becomes the merged PRs created at/after it,
//                         earliest first — the "first >=20 merged PRs after the
//                         cutover" re-run. --n is then the count (or `all`).
//   --min M               with `--n all`: exit 2 if fewer than M merged PRs
//                         qualify (default 20).
//   --events K            fetch issue events for the K most recently MERGED PRs
//                         of the population (default: all of them).
//   --bound B             the proposed In-flight bound (default 8).
//   --cache DIR           raw-JSON cache dir (default <os.tmpdir()>/in-flight-
//                         baseline-cache). Never inside the repo: a DIR under
//                         any git checkout is refused (exit 1).
//   --refresh             ignore cached pages and refetch everything.
//   --transport auto|gh|curl   force a transport (default auto).
//   --no-token            never send GITHUB_TOKEN with curl.
//   --allow-short         report on a population shorter than --n instead of
//                         exiting 2 (the result then carries a loud warning).
//   --json FILE           also write the computed numbers as JSON.
//
// Exit codes: 0 ok; 2 population shorter than requested (or a list page that
// could not be trusted: non-200, non-array, or a page cut short by anything
// other than the end of the listing); 1 any other failure.
//
// Truncation rule (docs/agents/issue-tracker.md's --limit rule, in code): a list
// is complete only when the last page read is SHORTER than per_page. A page
// exactly per_page long is followed by another request; a non-200 or non-array
// body is a failure, never an empty list; a population that comes up short of
// --n before the listing ends exits 2 rather than reporting on fewer.
//
// Every table the script prints names the query that produced it, so
// docs/research/in-flight-baseline.md can be regenerated from the output.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- flags ----
const argv = process.argv.slice(2);
const flags = {
  repo: "feigi/fleet-plugin",
  n: "400",
  after: null,
  min: 20,
  events: null,
  bound: 8,
  cache: path.join(os.tmpdir(), "in-flight-baseline-cache"),
  refresh: false,
  transport: "auto",
  noToken: false,
  allowShort: false,
  json: null,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    if (i + 1 >= argv.length) die(`flag ${a} needs a value`);
    return argv[++i];
  };
  switch (a) {
    case "--repo": flags.repo = next(); break;
    case "--n": flags.n = next(); break;
    case "--after": flags.after = next(); break;
    case "--min": flags.min = Number(next()); break;
    case "--events": flags.events = Number(next()); break;
    case "--bound": flags.bound = Number(next()); break;
    case "--cache": flags.cache = next(); break;
    case "--refresh": flags.refresh = true; break;
    case "--transport": flags.transport = next(); break;
    case "--no-token": flags.noToken = true; break;
    case "--allow-short": flags.allowShort = true; break;
    case "--json": flags.json = next(); break;
    case "-h": case "--help":
      process.stdout.write(fs.readFileSync(new URL(import.meta.url)).toString().split("\n")
        .filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
      process.exit(0);
    default: die(`unknown flag ${a}`);
  }
}
if (!/^[^/\s]+\/[^/\s]+$/.test(flags.repo)) die(`--repo must be owner/name, got ${flags.repo}`);
if (flags.n !== "all" && !(Number.isInteger(Number(flags.n)) && Number(flags.n) > 0)) die(`--n must be a positive integer or 'all'`);
if (flags.n === "all" && !flags.after) die(`--n all needs --after`);
if (flags.after && Number.isNaN(Date.parse(flags.after))) die(`--after must be an ISO-8601 instant`);
if (!(flags.bound >= 0)) die(`--bound must be a non-negative number`);
if (!["auto", "gh", "curl"].includes(flags.transport)) die(`--transport must be auto, gh or curl`);
const PER_PAGE = 100;
const RTM = "ready-to-merge";
const H = 3600_000, MIN = 60_000;

function die(msg, code = 1) { process.stderr.write(`in-flight-baseline: ${msg}\n`); process.exit(code); }
function log(msg) { process.stderr.write(`${msg}\n`); }

// ------------------------------------------------------------ transport ----
// Raw JSON never belongs in a checkout: refuse a cache dir that sits inside one.
for (let d = path.resolve(flags.cache); ; d = path.dirname(d)) {
  if (fs.existsSync(path.join(d, ".git"))) die(`--cache ${flags.cache} is inside the git checkout at ${d}; use a directory outside any repo (default ${path.join(os.tmpdir(), "in-flight-baseline-cache")})`);
  if (path.dirname(d) === d) break;
}
const repoCacheDir = path.join(flags.cache, flags.repo.replace("/", "__"));
fs.mkdirSync(repoCacheDir, { recursive: true });

function pickTransport() {
  if (flags.transport === "gh" || flags.transport === "auto") {
    const r = spawnSync("gh", ["auth", "status"], { encoding: "utf8" });
    if (r.status === 0) return { kind: "gh" };
    if (flags.transport === "gh") die(`--transport gh but \`gh auth status\` failed:\n${(r.stderr || r.stdout || "").trim()}`);
    log(`gh auth status failed (${(r.stderr || r.stdout || "").trim().split("\n")[0] || "no gh"}); falling back to curl`);
  }
  let token = flags.noToken ? null : (process.env.GITHUB_TOKEN || null);
  if (token) {
    // Probe the token before trusting it: an invalid token turns every read
    // into a 401, and a silent fallback would hide that. /rate_limit is free.
    const probe = curlRaw("https://api.github.com/rate_limit", token);
    if (probe.status === 401) { log("GITHUB_TOKEN is set but rejected (401); continuing without it"); token = null; }
    else if (probe.status !== 200) die(`token probe GET /rate_limit returned HTTP ${probe.status}`);
  }
  return { kind: "curl", token };
}

function curlRaw(url, token) {
  const args = ["-sS", "-w", "\n%{http_code}", "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28"];
  if (token) args.push("-H", `Authorization: Bearer ${token}`);
  args.push(url);
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status === 0 && typeof r.stdout === "string") {
      const cut = r.stdout.lastIndexOf("\n");
      const status = Number(r.stdout.slice(cut + 1).trim());
      return { status, body: r.stdout.slice(0, cut) };
    }
    if (attempt >= 3) die(`curl failed after ${attempt + 1} attempts: ${(r.stderr || "").trim()}`);
    const wait = 2000 * 2 ** attempt;
    log(`curl transport error (${(r.stderr || "").trim().split("\n")[0]}); retrying in ${wait / 1000}s`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
}

const transport = pickTransport();
log(`transport: ${transport.kind}${transport.kind === "curl" ? (transport.token ? " (GITHUB_TOKEN)" : " (unauthenticated)") : ""}; cache: ${repoCacheDir}`);

/** GET an API path (relative to https://api.github.com/), cached. Returns the
 *  parsed JSON body. Fails loudly on anything but HTTP 200. */
const fetchedAt = new Map(); // apiPath -> ISO instant the cached body was read from GitHub
function apiGet(apiPath) {
  const file = path.join(repoCacheDir, apiPath.replace(/[^A-Za-z0-9_.-]/g, "_") + ".json");
  if (!flags.refresh && fs.existsSync(file)) {
    const env = JSON.parse(fs.readFileSync(file, "utf8"));
    if (env.status === 200) { fetchedAt.set(apiPath, env.fetchedAt); return env.data; }
  }
  let status, body;
  if (transport.kind === "gh") {
    const r = spawnSync("gh", ["api", apiPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    if (r.status !== 0) die(`gh api ${apiPath} failed (exit ${r.status}): ${(r.stderr || "").trim()}`, 2);
    status = 200; body = r.stdout;
  } else {
    ({ status, body } = curlRaw(`https://api.github.com/${apiPath}`, transport.token));
    if (status !== 200) {
      const hint = status === 403 || status === 429 ? " (rate limited? check X-RateLimit headers; set GITHUB_TOKEN or wait)" : "";
      die(`GET ${apiPath} returned HTTP ${status}${hint}: ${body.slice(0, 300)}`, 2);
    }
  }
  let data;
  try { data = JSON.parse(body); } catch { die(`GET ${apiPath}: body is not JSON`, 2); }
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: now, transport: transport.kind, apiPath, status, data }));
  fetchedAt.set(apiPath, now);
  return data;
}

/** Read one list page; a non-array body is a failure, never an empty list. */
function listPage(basePath, page) {
  const data = apiGet(`${basePath}${basePath.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
  if (!Array.isArray(data)) die(`${basePath} page ${page}: expected a JSON array, got ${typeof data}`, 2);
  if (data.length > PER_PAGE) die(`${basePath} page ${page}: ${data.length} items on a per_page=${PER_PAGE} page`, 2);
  return data;
}

// ----------------------------------------------------------- population ----
const pullsQuery = `repos/${flags.repo}/pulls?state=closed&sort=created&direction=desc`;
const ts = (s) => Date.parse(s);

// Page newest-created-first until the population is assembled; keep every
// closed PR seen so carry-in (older PRs still open at the window start) and the
// closed-unmerged drop count can be read from the same pages.
const seen = [];
let pages = 0, listingEnded = false;
let population;
const wantN = flags.n === "all" ? Infinity : Number(flags.n);
const afterMs = flags.after ? ts(flags.after) : null;

function mergedSoFar() {
  const m = seen.filter((p) => p.merged_at && (afterMs === null || ts(p.created_at) >= afterMs));
  return m;
}
for (;;) {
  pages++;
  const page = listPage(pullsQuery, pages);
  seen.push(...page);
  if (page.length < PER_PAGE) { listingEnded = true; break; }
  if (afterMs === null && mergedSoFar().length >= wantN) break;
  // With --after the set is known only once a page reaches below the cutover.
  if (afterMs !== null && ts(page[page.length - 1].created_at) < afterMs) break;
  if (pages > 200) die("more than 200 pages read; refusing to continue", 2);
}
{
  const merged = mergedSoFar();           // newest-created first
  if (afterMs === null) {
    population = merged.slice(0, wantN);
  } else {
    population = merged.slice().reverse(); // oldest first = the first after the cutover
    if (flags.n !== "all") population = population.slice(0, wantN);
  }
  const need = flags.n === "all" ? flags.min : wantN;
  if (population.length < need) {
    const msg = `population is ${population.length} merged PRs, fewer than the ${need} requested` +
      (listingEnded ? " (the listing ended)" : "") + (afterMs !== null ? ` since ${flags.after}` : "");
    if (!flags.allowShort) die(`${msg}; pass --allow-short to report anyway`, 2);
    log(`WARNING: ${msg}; reporting anyway (--allow-short)`);
  }
}
if (population.length === 0) die("empty population", 2);
for (const p of population) if (!p.merged_at || !p.created_at) die(`PR #${p.number} lacks created_at/merged_at`);

const popNums = new Set(population.map((p) => p.number));
const winStart = Math.min(...population.map((p) => ts(p.created_at)));
const winEndCreated = Math.max(...population.map((p) => ts(p.created_at)));
const winEnd = Math.max(...population.map((p) => ts(p.merged_at)));
const closedUnmergedInWindow = seen.filter((p) => !p.merged_at && ts(p.created_at) >= winStart && ts(p.created_at) <= winEndCreated);
const mergedOutsideN = seen.filter((p) => p.merged_at && !popNums.has(p.number) && ts(p.created_at) >= winStart && ts(p.created_at) <= winEndCreated);

// Carry-in: closed PRs created BEFORE the window start whose close/merge falls
// after it — open at the window's first instant, invisible to a sweep over the
// population alone. Keep paging older until at least a full page of pre-window
// PRs is in hand and the oldest of them was created ≥7 days before the window
// (a PR open longer than that across the boundary would be visible there too).
let carryPagesExtra = 0;
for (;;) {
  const older = seen.filter((p) => ts(p.created_at) < winStart);
  const oldestSeen = seen.length ? ts(seen[seen.length - 1].created_at) : Infinity;
  if (listingEnded || (older.length >= PER_PAGE && oldestSeen < winStart - 7 * 24 * H)) break;
  if (carryPagesExtra >= 5) { log("carry-in scan stopped after 5 extra pages"); break; }
  pages++; carryPagesExtra++;
  const page = listPage(pullsQuery, pages);
  seen.push(...page);
  if (page.length < PER_PAGE) { listingEnded = true; break; }
}
const carryIn = seen.filter((p) => ts(p.created_at) < winStart && ts(p.merged_at || p.closed_at) > winStart);

// List pages are positional: page 1 is "the newest 100 closed PRs" at the time
// it was read, so a cached listing goes stale as PRs close. Record when the
// listing was read and warn when it is a day old.
const listReads = [...fetchedAt.entries()].filter(([k]) => k.startsWith(pullsQuery)).map(([, v]) => v).sort();
const listingReadAt = listReads.length ? `${listReads[0]}${listReads[0] !== listReads[listReads.length - 1] ? ` → ${listReads[listReads.length - 1]}` : ""}` : "—";
if (listReads.length && Date.now() - ts(listReads[0]) > 24 * H) log(`WARNING: the cached listing was read at ${listReads[0]}; pass --refresh (or a fresh --cache dir) to read today's pages`);

// ------------------------------------------------------------ statistics ----
const sortedNum = (xs) => xs.slice().sort((a, b) => a - b);
function pct(sorted, p) {            // linear interpolation on sorted data, as baseline-efficiency-derive.py's pct()
  if (sorted.length === 0) return NaN;
  const k = (sorted.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}
const median = (s) => pct(s, 0.5);
const fmtH = (ms) => Number.isNaN(ms) ? "—" : (ms / H).toFixed(2) + " h";
const fmtMin = (ms) => Number.isNaN(ms) ? "—" : (ms / MIN).toFixed(0) + " min";
const fmtHM = (ms) => Number.isNaN(ms) ? "—" : `${(ms / H).toFixed(2)} h (${Math.round(ms / MIN)} min)`;
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const pctStr = (a, b) => b ? `${((100 * a) / b).toFixed(1)}%` : "—";

/** Sweep +1 at created_at, -1 at merged_at over a set of intervals.
 *  Same-instant ordering: merges before arrivals, then arrivals by PR number.
 *  Returns time-weighted means, the max, per-day rows and depth-at-arrival
 *  for the PRs in `measure` (a Set of numbers). */
function sweep(intervals, measure) {
  const ev = [];
  for (const it of intervals) {
    ev.push({ t: it.start, d: +1, n: it.number });
    ev.push({ t: it.end, d: -1, n: it.number });
  }
  ev.sort((a, b) => a.t - b.t || a.d - b.d || a.n - b.n);
  let depth = 0, prev = ev[0].t, areaOpen = 0, timeOpen = 0, area = 0;
  let max = 0, maxAt = ev[0].t;
  const atArrival = new Map();
  const days = new Map();                        // day -> {arrivals, merges, peak, open0, area, span}
  const dayRow = (t) => {
    const k = day(t);
    if (!days.has(k)) days.set(k, { day: k, arrivals: 0, merges: 0, peak: 0, open0: null, area: 0, span: 0 });
    return days.get(k);
  };
  // Walk the timeline, splitting each constant-depth segment at UTC midnights
  // so per-day peaks and time-weighted means are exact.
  const segment = (from, to, d) => {
    let cur = from;
    while (cur < to) {
      const midnight = Date.UTC(new Date(cur).getUTCFullYear(), new Date(cur).getUTCMonth(), new Date(cur).getUTCDate() + 1);
      const stop = Math.min(to, midnight);
      const row = dayRow(cur);
      if (row.open0 === null) row.open0 = d;
      row.peak = Math.max(row.peak, d);
      row.area += d * (stop - cur); row.span += stop - cur;
      cur = stop;
    }
  };
  for (const e of ev) {
    if (e.t > prev) {
      area += depth * (e.t - prev);
      if (depth >= 1) { areaOpen += depth * (e.t - prev); timeOpen += e.t - prev; }
      segment(prev, e.t, depth);
      prev = e.t;
    }
    { const row = dayRow(e.t); if (row.open0 === null) row.open0 = depth; } // depth BEFORE the day's first event
    if (e.d === +1) {
      if (measure.has(e.n)) atArrival.set(e.n, depth);
      dayRow(e.t).arrivals++;
    } else dayRow(e.t).merges++;
    depth += e.d;
    if (depth > max) { max = depth; maxAt = e.t; }
    dayRow(e.t).peak = Math.max(dayRow(e.t).peak, depth);
  }
  const span = ev[ev.length - 1].t - ev[0].t;
  return { meanWhileOpen: areaOpen / timeOpen, meanWall: area / span, timeOpen, span, max, maxAt, atArrival, days: [...days.values()] };
}

const popIntervals = population.map((p) => ({ number: p.number, start: ts(p.created_at), end: ts(p.merged_at) }));
const S = sweep(popIntervals, popNums);
const carryIntervals = carryIn.map((p) => ({ number: p.number, start: ts(p.created_at), end: ts(p.merged_at || p.closed_at) }));
const S2 = sweep([...popIntervals, ...carryIntervals], popNums);

// Depth at arrival, cycle times, buckets.
const rows = population.map((p) => ({
  number: p.number, created: ts(p.created_at), merged: ts(p.merged_at),
  cycle: ts(p.merged_at) - ts(p.created_at), depth: S.atArrival.get(p.number), depthCarry: S2.atArrival.get(p.number),
}));
const depths = sortedNum(rows.map((r) => r.depth));
const cycles = sortedNum(rows.map((r) => r.cycle));
const hist = [];
for (let d = 0; d <= depths[depths.length - 1]; d++) hist.push({ depth: d, n: depths.filter((x) => x === d).length });
const buckets = [["0–2", 0, 2], ["3–5", 3, 5], ["6–9", 6, 9], ["10+", 10, Infinity]].map(([label, lo, hi]) => {
  const c = sortedNum(rows.filter((r) => r.depth >= lo && r.depth <= hi).map((r) => r.cycle));
  return { label, n: c.length, median: median(c), p90: pct(c, 0.9) };
});
const held = rows.filter((r) => r.depth >= flags.bound), rest = rows.filter((r) => r.depth < flags.bound);
const stat = (list) => { const c = sortedNum(list.map((r) => r.cycle)); return { n: c.length, median: median(c), p75: pct(c, 0.75), p90: pct(c, 0.9), max: c[c.length - 1] ?? NaN }; };
const heldStat = stat(held), restStat = stat(rest);
const heldCarry = rows.filter((r) => r.depthCarry >= flags.bound);

// Throughput.
const hourKey = (t) => Math.floor(t / H);
const activeHours = new Set(rows.flatMap((r) => [hourKey(r.created), hourKey(r.merged)]));
const wallHours = S.span / H;
const daySpans = new Map();
for (const r of rows) for (const t of [r.created, r.merged]) {
  const k = day(t); const d = daySpans.get(k) || { first: t, last: t };
  d.first = Math.min(d.first, t); d.last = Math.max(d.last, t); daySpans.set(k, d);
}
const daySpanHours = [...daySpans.values()].reduce((a, d) => a + (d.last - d.first) / H, 0);
const throughput = {
  activeClockHours: activeHours.size, perActiveClockHour: rows.length / activeHours.size,
  daySpanHours, perDaySpanHour: rows.length / daySpanHours,
  openHours: S.timeOpen / H, perOpenHour: rows.length / (S.timeOpen / H),
  wallHours, perWallHour: rows.length / wallHours,
  activeDays: daySpans.size, perActiveDay: rows.length / daySpans.size,
};

// ---------------------------------------------------------- label events ----
const byMergedDesc = rows.slice().sort((a, b) => b.merged - a.merged || b.number - a.number);
const evCount = flags.events === null ? byMergedDesc.length : Math.min(flags.events, byMergedDesc.length);
const evRows = [];
let evFetched = 0;
for (const r of byMergedDesc.slice(0, evCount)) {
  const base = `repos/${flags.repo}/issues/${r.number}/events`;
  const events = [];
  for (let page = 1; ; page++) {
    const pg = listPage(base, page);
    events.push(...pg);
    if (pg.length < PER_PAGE) break;
    if (page > 50) die(`#${r.number}: more than 50 event pages`, 2);
  }
  evFetched++;
  if (evFetched % 50 === 0) log(`events: ${evFetched}/${evCount}`);
  const labeled = events.filter((e) => e.event === "labeled" && e.label && e.label.name === RTM).map((e) => ts(e.created_at)).sort((a, b) => a - b);
  const unlabeled = events.filter((e) => e.event === "unlabeled" && e.label && e.label.name === RTM).length;
  const mergedEv = events.find((e) => e.event === "merged");
  // "Last label" means the last one applied at or before the merge: a label
  // re-applied to an already-merged PR is a relabel, not a queue wait.
  const preMerge = labeled.filter((t) => t <= r.merged);
  evRows.push({
    number: r.number, created: r.created, merged: r.merged, labeled, unlabeled,
    mergedEventAt: mergedEv ? ts(mergedEv.created_at) : null,
    first: labeled[0] ?? null, last: preMerge.length ? preMerge[preMerge.length - 1] : null,
    postMergeLabels: labeled.length - preMerge.length,
  });
}
const withLabel = evRows.filter((e) => e.last !== null);
const noLabel = evRows.filter((e) => e.last === null);
const lastToMerge = sortedNum(withLabel.map((e) => e.merged - e.last));
const createdToFirst = sortedNum(withLabel.map((e) => e.first - e.created));
const relabelled = withLabel.filter((e) => e.labeled.length > 1);
const over90 = lastToMerge.filter((x) => x > 90 * MIN).length;
const over180 = lastToMerge.filter((x) => x > 180 * MIN).length;
const postMerge = withLabel.filter((e) => e.postMergeLabels > 0);
const noMergedEvent = evRows.filter((e) => e.mergedEventAt === null);
const labelCountHist = new Map();
for (const e of withLabel) labelCountHist.set(e.labeled.length, (labelCountHist.get(e.labeled.length) || 0) + 1);
const evWindow = evRows.length ? { newest: byMergedDesc[0], oldest: byMergedDesc[evCount - 1] } : null;
// Per-day of merge, label->merge median: the guard reads this over a run.
const l2mByDay = new Map();
for (const e of withLabel) { const k = day(e.merged); (l2mByDay.get(k) || l2mByDay.set(k, []).get(k)).push(e.merged - e.last); }

// ----------------------------------------------------- confounder checks ----
// Could the depth↔cycle gradient (§ 2's bucket medians, § 3's held-vs-rest
// gap) be an artefact of WHICH DAY a PR arrived (day of week, a stall day), or
// of the merge gate's serialization (one merge per CI run)? Stratify by UTC
// day of creation, demean by day, decompose the cycle at the labels, and read
// the inter-merge spacing and the ready-queue depth at label time.
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dow = (t) => DOW[new Date(t).getUTCDay()];
const isWeekend = (t) => { const w = new Date(t).getUTCDay(); return w === 0 || w === 6; };
const BUCKETS = [["0–2", 0, 2], ["3–5", 3, 5], ["6–9", 6, 9], ["10+", 10, Infinity]];
const inBucket = (r, [, lo, hi]) => r.depth >= lo && r.depth <= hi;
const medOf = (xs) => median(sortedNum(xs));
const fmtSignedMin = (ms) => `${ms < 0 ? "−" : "+"}${Math.round(Math.abs(ms) / MIN)} min`;
function spearman(xs, ys) {            // rank correlation, ties averaged
  const rank = (a) => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]); const r = new Array(a.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
  const rx = rank(xs), ry = rank(ys), mx = rx.reduce((a, b) => a + b, 0) / rx.length, my = ry.reduce((a, b) => a + b, 0) / ry.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < rx.length; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) ** 2; syy += (ry[i] - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}
const rho = (list, fx, fy) => list.length >= 3 ? spearman(list.map(fx), list.map(fy)).toFixed(2) : "—";
const createdDays = [...new Set(rows.map((r) => day(r.created)))].sort();
const rowsOfDay = (d) => rows.filter((r) => day(r.created) === d);
const dayMedian = new Map(createdDays.map((d) => [d, medOf(rowsOfDay(d).map((r) => r.cycle))]));
const demeaned = (r) => r.cycle - dayMedian.get(day(r.created));
const heldDays = createdDays.filter((d) => rowsOfDay(d).filter((r) => r.depth >= flags.bound).length >= 10);
const strata = [
  ["Weekend (Sat/Sun, UTC)", rows.filter((r) => isWeekend(r.created))],
  ["Weekday", rows.filter((r) => !isWeekend(r.created))],
  [`Days with ≥10 arrivals at depth ≥ ${flags.bound} (${heldDays.join(", ") || "none"})`, rows.filter((r) => heldDays.includes(day(r.created)))],
  ["Other days", rows.filter((r) => !heldDays.includes(day(r.created)))],
  ["All", rows],
];
const bucketCells = (list, f = (r) => r.cycle, fmt = fmtH) => BUCKETS.map((b) => { const c = list.filter((r) => inBucket(r, b)); return c.length ? `${fmt(medOf(c.map(f)))} (n=${c.length})` : "— (n=0)"; });
const heldVsRest = (list) => { const h = list.filter((r) => r.depth >= flags.bound), o = list.filter((r) => r.depth < flags.bound); return `${h.length ? fmtH(medOf(h.map((r) => r.cycle))) : "—"} (n=${h.length}) vs ${o.length ? fmtH(medOf(o.map((r) => r.cycle))) : "—"} (n=${o.length})`; };
// Inter-merge spacing (Query P).
const mergeTimes = sortedNum(rows.map((r) => r.merged));
const gaps = mergeTimes.slice(1).map((t, i) => t - mergeTimes[i]);
const closestPair = (() => { let best = 0; for (let i = 1; i < gaps.length; i++) if (gaps[i] < gaps[best]) best = i; const a = rows.filter((r) => r.merged === mergeTimes[best]), b = rows.filter((r) => r.merged === mergeTimes[best + 1]); return gaps.length ? `#${a[0].number} → #${b[0].number}` : "—"; })();
const minutesWithTwoMerges = (() => { const m = new Map(); for (const t of mergeTimes) { const k = Math.floor(t / MIN); m.set(k, (m.get(k) || 0) + 1); } return [...m.values()].filter((v) => v >= 2).length; })();
const busiestMergeDays = [...new Set(rows.map((r) => day(r.merged)))].map((d) => { const m = sortedNum(rows.filter((r) => day(r.merged) === d).map((r) => r.merged)); const g = sortedNum(m.slice(1).map((t, i) => t - m[i])); return { d, n: m.length, g }; }).sort((a, b) => b.n - a.n).slice(0, 3);
// Ready-queue depth at the last label: other PRs (with events read) labelled at
// or before that instant and not yet merged at it — what the Pass had ahead.
for (const e of withLabel) e.readyQueue = withLabel.filter((o) => o !== e && o.last <= e.last && o.merged > e.last).length;
const RQ = [["0", 0, 0], ["1", 1, 1], ["2", 2, 2], ["3–4", 3, 4], ["5+", 5, Infinity]];
const rqCells = RQ.map(([, lo, hi]) => { const c = withLabel.filter((e) => e.readyQueue >= lo && e.readyQueue <= hi); return c.length ? `${fmtMin(medOf(c.map((e) => e.merged - e.last)))} (n=${c.length})` : "— (n=0)"; });
const evByNum = new Map(evRows.map((e) => [e.number, e]));
const labelledRows = rows.filter((r) => evByNum.get(r.number)?.last != null).map((r) => ({ ...r, ...evByNum.get(r.number) }));

// --------------------------------------------------------------- output ----
const out = [];
const P = (s = "") => out.push(s);
const table = (headers, body) => {
  P(`| ${headers.join(" | ")} |`); P(`|${headers.map(() => "---").join("|")}|`);
  for (const r of body) P(`| ${r.join(" | ")} |`);
};
const popSorted = population.slice().sort((a, b) => a.number - b.number);
const nums = popSorted.map((p) => p.number);
const absent = nums[nums.length - 1] - nums[0] + 1 - nums.length; // issues share the number space with PRs

P(`# In-flight baseline — derived ${new Date().toISOString().slice(0, 16)}Z`);
P();
P(`Repo \`${flags.repo}\`; transport ${transport.kind}${transport.kind === "curl" ? (transport.token ? " + GITHUB_TOKEN" : ", unauthenticated") : ""}; cache \`${repoCacheDir}\`.`);
P();
P(`## Population`);
P();
P(`Query P: \`GET /${pullsQuery}&per_page=${PER_PAGE}&page=N\`, pages 1–${pages} read (${seen.length} closed PRs seen${listingEnded ? ", listing ended" : ""}); listing read from GitHub at ${listingReadAt}.`);
P(`${afterMs === null ? `The ${population.length} most recently created merged PRs` : `The ${flags.n === "all" ? "" : "first "}${population.length} merged PRs created at/after ${flags.after}`}: **#${nums[0]}–#${nums[nums.length - 1]}** (${absent} numbers in that range are issues, PRs still open, or closed PRs outside the population).`);
P(`Created ${iso(winStart)} → ${iso(winEndCreated)}; merged ${iso(Math.min(...rows.map((r) => r.merged)))} → ${iso(winEnd)}.`);
P(`Closed-unmerged PRs created inside that created-span, dropped: **${closedUnmergedInWindow.length}**${closedUnmergedInWindow.length ? ` (${closedUnmergedInWindow.map((p) => "#" + p.number).join(", ")})` : ""}. Merged PRs created inside the span but outside the population (should be 0): ${mergedOutsideN.length}.`);
P(`Carry-in — closed PRs created before ${iso(winStart)} and still open at it: **${carryIn.length}**${carryIn.length ? ` (${carryIn.map((p) => `#${p.number} ${p.created_at}→${p.merged_at || p.closed_at + " closed"}`).join("; ")})` : ""}. They count in the sensitivity reading only.`);
P();
P(`## 1. In-flight depth (sweep over Query P: +1 at created_at, −1 at merged_at; same-instant merges before arrivals)`);
P();
table(["Measure", "Value", "Source"], [
  ["Time-weighted mean depth while ≥1 PR open", `**${S.meanWhileOpen.toFixed(2)}**`, `Σ depth·dt / Σ dt over depth≥1; open time ${fmtH(S.timeOpen)} of ${fmtH(S.span)} wall`],
  ["Time-weighted mean over the whole wall clock (first created → last merged)", S.meanWall.toFixed(2), "Σ depth·dt / wall span"],
  ["Max depth", `**${S.max}**`, `first reached ${iso(S.maxAt)}`],
  ["Depth already open at a PR's creation — median / p75 / p90 / max", `**${median(depths)} / ${pct(depths, 0.75)} / ${pct(depths, 0.9)} / ${depths[depths.length - 1]}**`, `n=${depths.length}; linear-interpolated percentiles`],
  ["Mean depth at arrival", (depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(2), ""],
  ["Sensitivity: + carry-in PRs (depth only)", `mean-while-open ${S2.meanWhileOpen.toFixed(2)}; max ${S2.max} at ${iso(S2.maxAt)}; at-arrival median/p75/p90 ${median(sortedNum(rows.map((r) => r.depthCarry)))}/${pct(sortedNum(rows.map((r) => r.depthCarry)), 0.75)}/${pct(sortedNum(rows.map((r) => r.depthCarry)), 0.9)}`, `${carryIn.length} carry-in interval(s) added to the sweep`],
]);
P();
P(`### Depth-at-arrival histogram (Query P)`);
P();
table(["Depth at arrival", "PRs", "Share", "Cum. share", ""], hist.map((h, i) => {
  const cum = hist.slice(0, i + 1).reduce((a, x) => a + x.n, 0);
  return [String(h.depth), String(h.n), pctStr(h.n, rows.length), pctStr(cum, rows.length), "█".repeat(Math.round((40 * h.n) / Math.max(...hist.map((x) => x.n))))];
}));
P();
P(`### Per UTC day (Query P)`);
P();
table(["Day (UTC)", "Open at day start", "Arrivals", "Merges", "Peak depth", "Mean depth"], S.days.map((d) => [d.day, String(d.open0 ?? 0), String(d.arrivals), String(d.merges), String(d.peak), d.span ? (d.area / d.span).toFixed(2) : "—"]));
P();
P(`## 2. Cycle time created_at → merged_at (Query P)`);
P();
table(["Measure", "Value"], [
  ["n", String(cycles.length)],
  ["min", fmtHM(cycles[0])], ["median", `**${fmtHM(median(cycles))}**`], ["p75", fmtHM(pct(cycles, 0.75))], ["p90", `**${fmtHM(pct(cycles, 0.9))}**`], ["max", fmtHM(cycles[cycles.length - 1])],
  ["mean", fmtHM(cycles.reduce((a, b) => a + b, 0) / cycles.length)],
]);
P();
P(`### By depth at arrival (Query P)`);
P();
table(["Depth at arrival", "n", "Cycle median", "Cycle p90"], buckets.map((b) => [b.label, String(b.n), fmtHM(b.median), fmtHM(b.p90)]));
P();
P(`## 3. The proposed bound ${flags.bound} (Query P)`);
P();
table(["Measure", "Value"], [
  [`Arrivals at depth ≥ ${flags.bound} (the Pulls the bound would have held)`, `**${held.length} of ${rows.length} (${pctStr(held.length, rows.length)})**`],
  [`… with carry-in counted`, `${heldCarry.length} of ${rows.length} (${pctStr(heldCarry.length, rows.length)})`],
  [`Cycle time, depth ≥ ${flags.bound}: n / median / p75 / p90 / max`, `${heldStat.n} / **${fmtHM(heldStat.median)}** / ${fmtHM(heldStat.p75)} / **${fmtHM(heldStat.p90)}** / ${fmtHM(heldStat.max)}`],
  [`Cycle time, depth < ${flags.bound}: n / median / p75 / p90 / max`, `${restStat.n} / **${fmtHM(restStat.median)}** / ${fmtHM(restStat.p75)} / **${fmtHM(restStat.p90)}** / ${fmtHM(restStat.max)}`],
  [`Share of all open-PR time spent at depth ≥ ${flags.bound}`, `${pctStr(timeAtOrAbove(popIntervals, flags.bound), S.timeOpen)} (${fmtH(timeAtOrAbove(popIntervals, flags.bound))} of ${fmtH(S.timeOpen)})`],
]);
P();
P(`## 4. Throughput (Query P)`);
P();
table(["Definition", "Hours", "Merged PRs / hour"], [
  ["**Primary — active clock hour**: a UTC clock hour with ≥1 arrival or ≥1 merge in the population", throughput.activeClockHours.toFixed(0), `**${throughput.perActiveClockHour.toFixed(2)}**`],
  ["Alternative A — per-day span: Σ over UTC days of (last event − first event), events = arrivals and merges", throughput.daySpanHours.toFixed(1), throughput.perDaySpanHour.toFixed(2)],
  ["Alternative B — open time: Σ dt while ≥1 PR in flight (the sweep's own clock)", throughput.openHours.toFixed(1), throughput.perOpenHour.toFixed(2)],
  ["Wall clock, first created → last merged (floor, counts idle nights)", throughput.wallHours.toFixed(1), throughput.perWallHour.toFixed(2)],
  ["Per active UTC day (a day with ≥1 arrival or merge)", `${throughput.activeDays} days`, `${throughput.perActiveDay.toFixed(1)} / day`],
]);
P();
if (evRows.length) {
  P(`## 5. \`${RTM}\` label timings (Query E: \`GET /repos/${flags.repo}/issues/<n>/events?per_page=${PER_PAGE}&page=N\`)`);
  P();
  P(`Events read for the **${evRows.length}** most recently merged PRs of the population: merged ${iso(evWindow.oldest.merged)} (#${evWindow.oldest.number}) → ${iso(evWindow.newest.merged)} (#${evWindow.newest.number}). ${withLabel.length} carry ≥1 \`labeled ${RTM}\` event; ${noLabel.length} carry none${noLabel.length ? ` (${noLabel.map((e) => "#" + e.number).join(", ")}; excluded from the timings)` : ""}.`);
  P();
  table(["Measure", "Value"], [
    [`Last \`${RTM}\` labeled → merged_at: median / p75 / p90 / max`, `**${fmtMin(median(lastToMerge))}** / ${fmtMin(pct(lastToMerge, 0.75))} / **${fmtHM(pct(lastToMerge, 0.9))}** / ${fmtHM(lastToMerge[lastToMerge.length - 1])} (n=${lastToMerge.length})`],
    [`… share > 90 min (ADR 0007 guard 1's median trigger)`, `**${over90} of ${lastToMerge.length} (${pctStr(over90, lastToMerge.length)})**`],
    [`… share > 3 h (guard 1's single-Pass trigger)`, `${over180} of ${lastToMerge.length} (${pctStr(over180, lastToMerge.length)})`],
    [`… PRs whose \`${RTM}\` was re-applied AFTER the merge (ignored for "last label")`, `${postMerge.length}${postMerge.length ? ` (${postMerge.map((e) => "#" + e.number).join(", ")})` : ""}`],
    [`… waits > 3 h, listed`, lastToMergeOver(180).map((e) => `#${e.number} ${fmtH(e.merged - e.last)} (merged ${day(e.merged)})`).join("; ") || "none"],
    [`PRs with no \`merged\` event in their timeline (merged_at still from Query P)`, `${noMergedEvent.length}${noMergedEvent.length ? ` (${noMergedEvent.map((e) => "#" + e.number).join(", ")})` : ""}`],
    [`created_at → first \`${RTM}\`: median / p75 / p90 / max`, `**${fmtHM(median(createdToFirst))}** / ${fmtHM(pct(createdToFirst, 0.75))} / **${fmtHM(pct(createdToFirst, 0.9))}** / ${fmtHM(createdToFirst[createdToFirst.length - 1])} (n=${createdToFirst.length})`],
    [`PRs labelled \`${RTM}\` more than once`, `**${relabelled.length} of ${withLabel.length} (${pctStr(relabelled.length, withLabel.length)})**`],
    [`Label-count distribution (labels: PRs)`, [...labelCountHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}: ${v}`).join(", ")],
    [`PRs with ≥1 \`unlabeled ${RTM}\` event`, String(withLabel.filter((e) => e.unlabeled > 0).length)],
    [`First label → merged (the whole queue wait, relabels included): median / p90`, `${fmtMin(median(sortedNum(withLabel.map((e) => e.merged - e.first))))} / ${fmtHM(pct(sortedNum(withLabel.map((e) => e.merged - e.first)), 0.9))}`],
  ]);
  P();
  P(`### Last label → merged, by UTC day of merge (Query E)`);
  P();
  table(["Day (UTC)", "n", "median", "p90", "> 90 min"], [...l2mByDay.entries()].sort().map(([k, v]) => { const s = sortedNum(v); return [k, String(s.length), fmtMin(median(s)), fmtMin(pct(s, 0.9)), String(s.filter((x) => x > 90 * MIN).length)]; }));
  P();
}
P(`## 6. Confounder checks — is the depth↔cycle gradient a day artefact, or the merge gate's serialization? (Query P; Query E where named)`);
P();
P(`### Cycle median by depth at arrival, per UTC day of creation (Query P)`);
P();
table(["Day (UTC)", "n", "All depths", ...BUCKETS.map((b) => b[0]), "ρ(depth, cycle)"], [
  ...createdDays.map((d) => { const xs = rowsOfDay(d); return [`${d} ${dow(ts(d))}`, String(xs.length), fmtH(dayMedian.get(d)), ...bucketCells(xs), xs.length >= 20 ? rho(xs, (r) => r.depth, (r) => r.cycle) : "— (n<20)"]; }),
  ...strata.map(([name, xs]) => [`**${name}**`, String(xs.length), xs.length ? fmtH(medOf(xs.map((r) => r.cycle))) : "—", ...bucketCells(xs), rho(xs, (r) => r.depth, (r) => r.cycle)]),
]);
P();
P(`### Day-demeaned: cycle − the median cycle of the PR's own creation day (Query P)`);
P();
table(["Measure", "Value"], [
  ["ρ(depth at arrival, cycle), all", rho(rows, (r) => r.depth, (r) => r.cycle)],
  ["ρ(depth at arrival, cycle − day median), all", rho(rows, (r) => r.depth, demeaned)],
  [`Median (cycle − day median) by depth bucket ${BUCKETS.map((b) => b[0]).join(" / ")}`, bucketCells(rows, demeaned, fmtSignedMin).join(" / ")],
  [`Cycle median, depth ≥ ${flags.bound} vs < ${flags.bound}, on the days with ≥10 held arrivals only`, heldVsRest(strata[2][1])],
  [`… on the other days`, heldVsRest(strata[3][1])],
]);
P();
if (withLabel.length) {
  P(`### Where in the cycle the gradient sits (Query E, the ${withLabel.length} labelled PRs with events read)`);
  P();
  table(["Depth at arrival", "n", "created → first label, median", "first label → merged, median", "last label → merged, median", "last label → merged, p90"], BUCKETS.map((b) => {
    const c = labelledRows.filter((r) => inBucket(r, b));
    return [b[0], String(c.length), c.length ? fmtH(medOf(c.map((r) => r.first - r.created))) : "—", c.length ? fmtMin(medOf(c.map((r) => r.merged - r.first))) : "—", c.length ? fmtMin(medOf(c.map((r) => r.merged - r.last))) : "—", c.length ? fmtMin(pct(sortedNum(c.map((r) => r.merged - r.last)), 0.9)) : "—"];
  }));
  P();
  table(["Rank correlation (Spearman ρ)", "Value"], [
    ["ρ(depth at arrival, created → first label)", rho(labelledRows, (r) => r.depth, (r) => r.first - r.created)],
    ["ρ(depth at arrival, last label → merged)", rho(labelledRows, (r) => r.depth, (r) => r.merged - r.last)],
    ["ρ(ready-queue depth at last label, last label → merged)", rho(labelledRows, (r) => r.readyQueue, (r) => r.merged - r.last)],
    ["ρ(depth at arrival, ready-queue depth at last label)", rho(labelledRows, (r) => r.depth, (r) => r.readyQueue)],
  ]);
  P();
}
P(`### Merge-gate serialization (Query P; Query E for the ready queue)`);
P();
table(["Measure", "Value"], [
  [`Inter-merge gap, all ${gaps.length} gaps: min / median; gaps < 5 min / < 10 min`, `${(Math.min(...gaps) / 1000).toFixed(0)} s (${closestPair}) / ${fmtMin(medOf(gaps))}; ${gaps.filter((g) => g < 5 * MIN).length} / ${gaps.filter((g) => g < 10 * MIN).length}`],
  ["UTC minutes holding ≥ 2 merges", String(minutesWithTwoMerges)],
  ...busiestMergeDays.map(({ d, n, g }) => [`${d} ${dow(ts(d))}: merges; gap min / p10 / median; gaps < 5 min / < 10 min`, `${n}; ${g.length ? `${(g[0] / 1000).toFixed(0)} s / ${fmtMin(pct(g, 0.1))} / ${fmtMin(medOf(g))}; ${g.filter((x) => x < 5 * MIN).length} / ${g.filter((x) => x < 10 * MIN).length}` : "—"}`]),
  ...(withLabel.length ? [[`Last label → merged by ready-queue depth at the last label (${RQ.map((q) => q[0]).join(" / ")} other labelled PRs ahead)`, rqCells.join(" / ")]] : []),
]);
P();
P(`## Population list (Query P)`);
P();
P(`<details><summary>${rows.length} PRs: number, created_at, merged_at, depth at arrival, cycle (h)</summary>`);
P();
P("```");
for (const r of rows.slice().sort((a, b) => a.number - b.number)) P(`#${r.number}\t${iso(r.created)}\t${iso(r.merged)}\tdepth=${r.depth}\tcycle=${(r.cycle / H).toFixed(2)}h`);
P("```");
P();
P(`</details>`);
process.stdout.write(out.join("\n") + "\n");

function lastToMergeOver(minutes) {
  return withLabel.filter((e) => e.merged - e.last > minutes * MIN).sort((a, b) => (b.merged - b.last) - (a.merged - a.last));
}

function timeAtOrAbove(intervals, bound) {
  const ev = intervals.flatMap((it) => [{ t: it.start, d: 1 }, { t: it.end, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d);
  let depth = 0, prev = ev[0].t, acc = 0;
  for (const e of ev) { if (depth >= bound) acc += e.t - prev; prev = e.t; depth += e.d; }
  return acc;
}

if (flags.json) {
  fs.writeFileSync(flags.json, JSON.stringify({
    generatedAt: new Date().toISOString(), repo: flags.repo, flags,
    population: { n: rows.length, first: nums[0], last: nums[nums.length - 1], createdFrom: iso(winStart), createdTo: iso(winEndCreated), mergedTo: iso(winEnd), closedUnmergedDropped: closedUnmergedInWindow.map((p) => p.number), carryIn: carryIn.map((p) => p.number), pagesRead: pages },
    depth: { meanWhileOpen: S.meanWhileOpen, meanWall: S.meanWall, max: S.max, maxAt: iso(S.maxAt), atArrival: { median: median(depths), p75: pct(depths, 0.75), p90: pct(depths, 0.9), max: depths[depths.length - 1] }, histogram: hist, days: S.days, withCarryIn: { meanWhileOpen: S2.meanWhileOpen, max: S2.max, maxAt: iso(S2.maxAt) } },
    cycleH: { median: median(cycles) / H, p75: pct(cycles, 0.75) / H, p90: pct(cycles, 0.9) / H, max: cycles[cycles.length - 1] / H, min: cycles[0] / H, buckets: buckets.map((b) => ({ ...b, median: b.median / H, p90: b.p90 / H })) },
    bound: { value: flags.bound, heldN: held.length, heldShare: held.length / rows.length, held: { ...heldStat, median: heldStat.median / H, p75: heldStat.p75 / H, p90: heldStat.p90 / H, max: heldStat.max / H }, rest: { ...restStat, median: restStat.median / H, p75: restStat.p75 / H, p90: restStat.p90 / H, max: restStat.max / H } },
    throughput,
    confounders: {
      perCreatedDay: createdDays.map((d) => { const xs = rowsOfDay(d); return { day: d, dow: dow(ts(d)), n: xs.length, medianH: dayMedian.get(d) / H, bucketMedianH: BUCKETS.map((b) => { const c = xs.filter((r) => inBucket(r, b)); return c.length ? medOf(c.map((r) => r.cycle)) / H : null; }), rho: xs.length >= 20 ? spearman(xs.map((r) => r.depth), xs.map((r) => r.cycle)) : null }; }),
      heldDays, rhoDepthCycle: spearman(rows.map((r) => r.depth), rows.map((r) => r.cycle)), rhoDepthCycleDemeaned: spearman(rows.map((r) => r.depth), rows.map(demeaned)),
      demeanedBucketMedianMin: BUCKETS.map((b) => { const c = rows.filter((r) => inBucket(r, b)); return c.length ? medOf(c.map(demeaned)) / MIN : null; }),
      interMergeGapMin: { min: Math.min(...gaps) / MIN, median: medOf(gaps) / MIN, under5: gaps.filter((g) => g < 5 * MIN).length, under10: gaps.filter((g) => g < 10 * MIN).length, minutesWithTwoMerges },
      readyQueue: withLabel.length ? RQ.map(([label, lo, hi]) => { const c = withLabel.filter((e) => e.readyQueue >= lo && e.readyQueue <= hi); return { label, n: c.length, lastToMergeMedianMin: c.length ? medOf(c.map((e) => e.merged - e.last)) / MIN : null }; }) : null,
    },
    labels: evRows.length ? { n: evRows.length, withLabel: withLabel.length, noLabel: noLabel.map((e) => e.number), lastToMergeMin: { median: median(lastToMerge) / MIN, p75: pct(lastToMerge, 0.75) / MIN, p90: pct(lastToMerge, 0.9) / MIN, max: lastToMerge[lastToMerge.length - 1] / MIN, over90: over90, over180 }, createdToFirstH: { median: median(createdToFirst) / H, p75: pct(createdToFirst, 0.75) / H, p90: pct(createdToFirst, 0.9) / H, max: createdToFirst[createdToFirst.length - 1] / H }, relabelled: relabelled.map((e) => e.number) } : null,
    rows: rows.map((r) => ({ number: r.number, created: iso(r.created), merged: iso(r.merged), depth: r.depth, cycleH: r.cycle / H })),
  }, null, 2));
  log(`json written to ${flags.json}`);
}
