#!/usr/bin/env node
// Derivation script for issue #2872 (map #2870): decompose each merged PR's
// created→merged cycle time into the stages the GitHub tracker can see, per
// depth-at-arrival bucket, and test depth against same-day arrivals.
//
// Zero dependencies. Reads GitHub REST only — never a session transcript or
// the ledger — so it reproduces on any machine that can reach api.github.com.
//
//   node docs/research/in-flight-cycle-time-stages-derive.mjs \
//     [--repo feigi/fleet-plugin] [--population 200] [--cache <dir>] \
//     [--buffer-pages 1] [--concurrency 6] [--refresh]
//
// Transport: `gh api` when `gh auth status` succeeds, else curl (honouring
// GITHUB_TOKEN when set). Node's fetch is not used: it ignores the proxy
// environment this was first run under. Every response is cached as raw JSON
// under --cache (default: a directory under os.tmpdir(), never in the repo);
// --refresh ignores the cache.
//
// Population: the first --population merged PRs in
//   GET /repos/<repo>/pulls?state=closed&sort=created&direction=desc
// order (the most recently CREATED merged PRs), pages of 100 until enough
// merged PRs are in hand. Closed-but-unmerged PRs are dropped and counted. A
// page that is not a JSON array, or an HTTP status other than 200, exits 2 —
// a truncated page is never counted as a short (final) one. --buffer-pages
// older pages are fetched too, used only for the depth sensitivity line.
//
// Per PR, five more reads (and one per linked issue):
//   GET /issues/<n>/events      labeled/unlabeled (label name), head_ref_force_pushed, merged
//   GET /pulls/<n>/commits      commit.author.date — a commit authored after
//                              the PR opened is the fix-applier's
//   GET /pulls/<n>/reviews      review-side writes (none in this population)
//   GET /pulls/<n>/comments     review comments (none in this population)
//   GET /issues/<n>/comments    the fix-applier's report comment
//   GET /issues/<m>/events      for each `Closes #m` in the body: `in-progress`
//                              label adds (the Claim)
//
// Stage definitions (see the note beside this script for why each stand-in):
//   open        = pull.created_at
//   evidence    = earliest of: first post-open commit author date; first
//                 review-side comment before merge (body opens "Review",
//                 "Fix-applier" or "Deferred from"); first head_ref_force_pushed
//                 before the first ready-to-merge; the first ready-to-merge
//   label1      = first `labeled ready-to-merge`;  labelLast = last one before merge
//   merged      = pull.merged_at
//   (a) open→evidence  (b) evidence→label1  (c) label1→merged
//   (c') labelLast→merged  churn = labelLast − label1
//   (d) each `unlabeled ready-to-merge` → next `labeled ready-to-merge`:
//       gap ≤ 60 s with no push or comment inside = re-pin flip (not churn);
//       otherwise churn, with its legible shape (see classifyChurn).
//   depth at arrival = population PRs with created_at < open and merged_at > open
import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------- flags ----
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`--${name} needs a value`);
  return v;
};
const has = (name) => argv.includes(`--${name}`);
function die(msg, code = 2) { console.error(`in-flight-cycle-time-stages: ${msg}`); process.exit(code); }

const REPO = flag("repo", "feigi/fleet-plugin");
const N = Number(flag("population", "200"));
const BUFFER_PAGES = Number(flag("buffer-pages", "1"));
const CONCURRENCY = Number(flag("concurrency", "6"));
const REFRESH = has("refresh");
// Optional window on created_at: keep PRs created at/after --since and before
// --until (ISO 8601). The population is then the first --population merged
// PRs inside the window, newest first.
const SINCE = flag("since", null) ? T(flag("since")) : -Infinity;
const UNTIL = flag("until", null) ? T(flag("until")) : Infinity;
if (Number.isNaN(SINCE) || Number.isNaN(UNTIL)) die("--since/--until must be ISO 8601 timestamps");
const CACHE = flag("cache", path.join(os.tmpdir(), "in-flight-cycle-time-stages-cache", REPO.replace("/", "__")));
if (!/^[\w.-]+\/[\w.-]+$/.test(REPO)) die(`--repo must be owner/name, got ${REPO}`);
if (!Number.isInteger(N) || N < 1) die(`--population must be a positive integer`);
if (path.resolve(CACHE).startsWith(process.cwd() + path.sep) && fs.existsSync(path.join(process.cwd(), ".git"))) die(`--cache ${CACHE} is inside the repository; keep raw JSON out of the tree`);
fs.mkdirSync(CACHE, { recursive: true });

// ------------------------------------------------------------ transport ----
const PER_PAGE = 100;
const ghAuthed = spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status === 0;
console.error(`transport: ${ghAuthed ? "gh api" : `curl${process.env.GITHUB_TOKEN ? " + GITHUB_TOKEN" : " (unauthenticated)"}`}; cache: ${CACHE}`);

const cacheFile = (p) => path.join(CACHE, p.replace(/[^A-Za-z0-9._-]/g, "_") + ".json");

async function api(p) {
  const f = cacheFile(p);
  if (!REFRESH && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  let body;
  for (let attempt = 0; ; attempt++) {
    try {
      if (ghAuthed) {
        body = (await execFileP("gh", ["api", `repos/${REPO}/${p}`], { maxBuffer: 64 << 20 })).stdout;
      } else {
        const args = ["-sS", "-w", "\n%{http_code}", `https://api.github.com/repos/${REPO}/${p}`];
        if (process.env.GITHUB_TOKEN) args.unshift("-H", `Authorization: Bearer ${process.env.GITHUB_TOKEN}`);
        const out = (await execFileP("curl", args, { maxBuffer: 64 << 20 })).stdout;
        const i = out.lastIndexOf("\n");
        const code = out.slice(i + 1).trim();
        if (code !== "200") throw new Error(`HTTP ${code}: ${out.slice(0, 200)}`);
        body = out.slice(0, i);
      }
      break;
    } catch (e) {
      if (attempt >= 4 || /HTTP 4(0[0-13-9]|[1-9]\d)/.test(e.message)) die(`${p}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  let json;
  try { json = JSON.parse(body); } catch { die(`${p}: response is not JSON (truncated?)`); }
  fs.writeFileSync(f, JSON.stringify(json));
  return json;
}

// Every page must be an array; a page of PER_PAGE items means another page
// follows; a shorter one is the last. Anything else is a refusal, never a
// short list.
async function pagedList(p, { maxPages = Infinity } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await api(`${p}${p.includes("?") ? "&" : "?"}per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(d)) die(`${p} page ${page}: not an array (${JSON.stringify(d).slice(0, 120)})`);
    all.push(...d);
    if (d.length < PER_PAGE) return { items: all, pages: page, exhausted: true };
  }
  return { items: all, pages: maxPages, exhausted: false };
}

async function pool(items, k, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(Array.from({ length: k }, async () => { for (const x of it) await fn(x); }));
}

// ------------------------------------------------------------- helpers ----
function T(s) { return new Date(s).getTime(); }
const H = 3600e3, MIN = 60e3;
const hours = (ms) => ms / H;
const sorted = (xs) => [...xs].sort((a, b) => a - b);
function pct(xs, p) {               // linear interpolation, as baseline-efficiency-derive.py
  const s = sorted(xs); if (s.length === 0) return NaN;
  const k = (s.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, s.length - 1);
  return s[f] + (s[c] - s[f]) * (k - f);
}
const median = (xs) => pct(xs, 0.5);
const fmtH = (ms) => Number.isNaN(ms) ? "—" : hours(ms) >= 1 ? `${hours(ms).toFixed(2)} h` : `${(ms / MIN).toFixed(0)} min`;
const fmtPct = (num, den) => den ? `${(100 * num / den).toFixed(0)} % (${num}/${den})` : "—";
const bucketOf = (d) => (d <= 2 ? "0-2" : d <= 5 ? "3-5" : d <= 9 ? "6-9" : "10+");
const BUCKETS = ["0-2", "3-5", "6-9", "10+"];
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const CLOSES = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi;
const REVIEW_COMMENT = /^\s*(?:review\b|fix-applier\b|deferred from\b)/i;
const RTM = "ready-to-merge";
const table = (head, rows) => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

// ------------------------------------------------------------ population ----
const closed = [];
let pages = 0, exhausted = false;
for (;;) {
  pages++;
  const d = await api(`pulls?state=closed&sort=created&direction=desc&per_page=${PER_PAGE}&page=${pages}`);
  if (!Array.isArray(d)) die(`pulls page ${pages}: not an array`);
  closed.push(...d.filter((x) => T(x.created_at) < UNTIL));
  if (d.length < PER_PAGE) { exhausted = true; break; }
  if (T(d[d.length - 1].created_at) < SINCE) { exhausted = true; break; }   // older than the window from here on
  if (closed.filter((x) => x.merged_at && T(x.created_at) >= SINCE).length >= N) break;
}
const inWindow = closed.filter((x) => T(x.created_at) >= SINCE);
const mergedAll = inWindow.filter((x) => x.merged_at);
if (mergedAll.length < N) die(`only ${mergedAll.length} merged PRs exist among ${inWindow.length} closed in the window; cannot build a population of ${N}`, 1);
const pop = mergedAll.slice(0, N).map((p) => ({ n: p.number, created: T(p.created_at), merged: T(p.merged_at), body: p.body || "", title: p.title, raw: p }));
const droppedUnmerged = inWindow.length - mergedAll.length;
const buffer = [];
for (let b = 1; b <= BUFFER_PAGES && !exhausted; b++) {
  const d = await api(`pulls?state=closed&sort=created&direction=desc&per_page=${PER_PAGE}&page=${pages + b}`);
  if (!Array.isArray(d)) die(`pulls buffer page ${pages + b}: not an array`);
  buffer.push(...d.filter((x) => x.merged_at).map((p) => ({ n: p.number, created: T(p.created_at), merged: T(p.merged_at) })));
  if (d.length < PER_PAGE) break;
}
const openNow = await pagedList("pulls?state=open");
pop.sort((a, b) => a.created - b.created);
const first = pop[0], last = pop[pop.length - 1];

// ----------------------------------------------------------- per-PR reads ----
let done = 0;
await pool(pop, CONCURRENCY, async (pr) => {
  pr.events = (await pagedList(`issues/${pr.n}/events`)).items;
  pr.commits = (await pagedList(`pulls/${pr.n}/commits`)).items;
  pr.reviews = (await pagedList(`pulls/${pr.n}/reviews`)).items;
  pr.reviewComments = (await pagedList(`pulls/${pr.n}/comments`)).items;
  pr.comments = (await pagedList(`issues/${pr.n}/comments`)).items;
  pr.linked = [...new Set([...pr.body.matchAll(CLOSES)].map((m) => Number(m[1])))];
  pr.linkedEvents = {};
  for (const m of pr.linked) pr.linkedEvents[m] = (await pagedList(`issues/${m}/events`)).items;
  if (++done % 50 === 0) console.error(`  ${done}/${pop.length} PRs read`);
});

// ------------------------------------------------------------- derive ----
for (const pr of pop) {
  const ev = pr.events.map((e) => ({ t: T(e.created_at), kind: e.event, label: e.label?.name ?? null, sha: e.commit_id ?? null })).sort((a, b) => a.t - b.t);
  const rtm = ev.filter((e) => e.label === RTM && e.t <= pr.merged);
  const labels = rtm.filter((e) => e.kind === "labeled").map((e) => e.t);
  const unlabels = rtm.filter((e) => e.kind === "unlabeled").map((e) => e.t);
  const pushes = ev.filter((e) => e.kind === "head_ref_force_pushed").map((e) => e.t);
  const postOpenCommits = sorted(pr.commits.map((c) => T(c.commit.author.date)).filter((t) => t > pr.created));
  const reviewComments = sorted(pr.comments.filter((c) => REVIEW_COMMENT.test(c.body) && T(c.created_at) < pr.merged).map((c) => T(c.created_at)));
  const haltComments = pr.comments.filter((c) => /^finisher-pr-\d+(?:-[a-z])? halted/i.test(c.body)).map((c) => T(c.created_at));
  pr.label1 = labels[0] ?? null;
  pr.labelLast = labels.length ? labels[labels.length - 1] : null;
  pr.labelCount = labels.length;
  const cands = {};
  if (postOpenCommits.length) cands.commit = postOpenCommits[0];
  if (reviewComments.length) cands.comment = reviewComments[0];
  const prePush = pushes.filter((t) => pr.label1 === null || t < pr.label1);
  if (prePush.length) cands.push = prePush[0];
  if (pr.label1 !== null) cands.label = pr.label1;
  pr.evidenceKind = Object.keys(cands).sort((a, b) => cands[a] - cands[b])[0] ?? null;
  pr.evidence = pr.evidenceKind ? cands[pr.evidenceKind] : null;
  pr.cycle = pr.merged - pr.created;
  pr.a = pr.evidence !== null ? pr.evidence - pr.created : null;
  pr.b = pr.evidence !== null && pr.label1 !== null ? pr.label1 - pr.evidence : null;
  pr.c = pr.label1 !== null ? pr.merged - pr.label1 : null;
  pr.cPrime = pr.labelLast !== null ? pr.merged - pr.labelLast : null;
  pr.churnSpan = pr.label1 !== null ? pr.labelLast - pr.label1 : null;
  // (d) each unlabel → next relabel
  pr.flips = []; pr.churns = [];
  for (const u of unlabels) {
    const prevLabel = Math.max(...labels.filter((t) => t < u), -Infinity);
    const relabel = labels.find((t) => t > u) ?? null;
    const gap = relabel === null ? null : relabel - u;
    const inside = (t) => t > u && relabel !== null && t < relabel;
    const pushInside = pushes.some(inside) || postOpenCommits.some(inside);
    const commentInside = pr.comments.some((c) => inside(T(c.created_at)));
    const pushBefore = pushes.some((t) => t > prevLabel && t <= u) || postOpenCommits.some((t) => t > prevLabel && t <= u);
    const rec = { unlabel: u, relabel, gap, pushBefore, pushInside, halt: haltComments.some((t) => t > prevLabel && t <= (relabel ?? pr.merged)) };
    if (relabel === null) { rec.shape = "merged-unlabelled"; pr.churns.push(rec); }
    else if (gap <= 60e3 && !pushInside && !commentInside) pr.flips.push(rec);
    else { rec.shape = classifyChurn(rec); pr.churns.push(rec); }
  }
  pr.churned = pr.churns.length > 0;
  pr.churnLost = pr.churns.reduce((s, c) => s + (c.gap ?? 0), 0);
  // (c'') the last label that is not a re-pin flip's relabel → merged: the
  // merge-side wait without the bot's own pre-merge flip shortening it.
  const flipRelabels = new Set(pr.flips.map((f) => f.relabel));
  const subst = labels.filter((t) => !flipRelabels.has(t));
  pr.labelLastSubst = subst.length ? subst[subst.length - 1] : null;
  pr.cSubst = pr.labelLastSubst !== null ? pr.merged - pr.labelLastSubst : null;
  // the Claim: last `labeled in-progress` on a linked issue before the PR opened
  const claims = pr.linked.flatMap((m) => pr.linkedEvents[m].filter((e) => e.event === "labeled" && e.label?.name === "in-progress" && T(e.created_at) < pr.created).map((e) => T(e.created_at)));
  pr.claim = claims.length ? Math.max(...claims) : null;
  pr.pushCount = pushes.length;
  pr.reviewWrites = pr.reviews.length + pr.reviewComments.length;
  pr.hasReviewComment = reviewComments.length > 0;
  pr.commentAfterCommit = postOpenCommits.length && reviewComments.length ? reviewComments[0] - postOpenCommits[0] : null;
  pr.earlyCommit = postOpenCommits.length > 0 && postOpenCommits[0] - pr.created < 5 * MIN;
  pr.ledgerVocabComments = pr.comments.filter((c) => /held-behind|conflict-hold|past-pin|head-moved-after-label|label-pulled|rebase-fallback/i.test(c.body)).length;
}

// The shapes the tracker can tell apart. The ledger's own causes
// (merge-bot refusal, past-pin re-review, finisher halt, held-behind, conflict
// hold) are not on GitHub; these stand in for them.
function classifyChurn(rec) {
  if (rec.halt) return "finisher-halt-comment";
  if (rec.pushBefore && !rec.pushInside) return "push-then-label-off";       // head moved after the label; label cleared; fresh audit relabels
  if (rec.pushBefore && rec.pushInside) return "push-then-label-off+push";   // as above, and a further push landed before the relabel
  if (!rec.pushBefore && rec.pushInside) return "label-off-then-push";       // label pulled ahead of an approved push (fix-applier), relabelled after it
  return "label-off-no-push";                                                 // nothing pushed either side; cause not legible
}

// depth at arrival, same-day arrivals, local arrival rate, queue ahead at label
for (const pr of pop) {
  pr.depth = pop.filter((q) => q.created < pr.created && q.merged > pr.created).length;
  pr.depthBuf = pr.depth + buffer.filter((q) => q.created < pr.created && q.merged > pr.created).length;
  pr.bucket = bucketOf(pr.depth);
  pr.day = day(pr.created);
  pr.sameDay = pop.filter((q) => q.day === pr.day).length;
  pr.nearby = pop.filter((q) => q !== pr && Math.abs(q.created - pr.created) <= H).length;
  pr.lowerOpenAtLabel = pr.label1 === null ? null : pop.filter((q) => q.n < pr.n && q.created < pr.label1 && q.merged > pr.label1).length;
}

// Fleet liveness. Every tracker write on any population PR (open, label on/off,
// force push, pre-merge comment, merge) is a sign the fleet was running. A gap
// of more than DORMANT_AFTER between consecutive writes is read as the fleet
// being dormant from DORMANT_AFTER into the gap until the next write; a PR's
// "live" interval is its wall-clock interval minus those dormant stretches.
const DORMANT_AFTER = 30 * MIN;    // p99 of the inter-write gap in the first run; the gaps above it are hours long
const writes = sorted(pop.flatMap((p) => [p.created, p.merged,
  ...p.events.filter((e) => e.event === "head_ref_force_pushed" || (e.label?.name === RTM && e.event !== undefined)).map((e) => T(e.created_at)),
  ...p.comments.filter((c) => T(c.created_at) < p.merged).map((c) => T(c.created_at))]));
const dormant = [];
for (let i = 1; i < writes.length; i++) if (writes[i] - writes[i - 1] > DORMANT_AFTER) dormant.push([writes[i - 1] + DORMANT_AFTER, writes[i]]);
const dormantTotal = dormant.reduce((s, [a, b]) => s + (b - a), 0);
const liveSpan = (a, b) => (a === null || b === null) ? null : (b - a) - dormant.reduce((s, [x, y]) => s + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
for (const pr of pop) {
  pr.cycleLive = liveSpan(pr.created, pr.merged);
  pr.aLive = liveSpan(pr.created, pr.evidence);
  pr.bLive = liveSpan(pr.evidence, pr.label1);
  pr.cLive = liveSpan(pr.label1, pr.merged);
  pr.dormantHit = pr.cycleLive < pr.cycle;
}

// ------------------------------------------------------------ statistics ----
function ols(y, X) {                 // y: n; X: n × k (no intercept column); returns coef, se, r2
  const n = y.length, k = X[0].length + 1;
  const A = X.map((r) => [1, ...r]);
  const XtX = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => A.reduce((s, r) => s + r[i] * r[j], 0)));
  const Xty = Array.from({ length: k }, (_, i) => A.reduce((s, r, m) => s + r[i] * y[m], 0));
  const inv = invert(XtX);
  const beta = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  const yhat = A.map((r) => r.reduce((s, v, j) => s + v * beta[j], 0));
  const ybar = y.reduce((s, v) => s + v, 0) / n;
  const ssr = y.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0), sst = y.reduce((s, v) => s + (v - ybar) ** 2, 0);
  const sigma2 = ssr / (n - k);
  const se = inv.map((row, i) => Math.sqrt(row[i] * sigma2));
  return { beta, se, t: beta.map((b, i) => b / se[i]), r2: 1 - ssr / sst, n };
}
function invert(M) {                 // Gauss-Jordan
  const k = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let i = 0; i < k; i++) {
    let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]];
    const d = A[i][i]; if (Math.abs(d) < 1e-12) die("singular design matrix");
    for (let j = 0; j < 2 * k; j++) A[i][j] /= d;
    for (let r = 0; r < k; r++) if (r !== i) { const f = A[r][i]; for (let j = 0; j < 2 * k; j++) A[r][j] -= f * A[i][j]; }
  }
  return A.map((r) => r.slice(k));
}
function spearman(xs, ys) {
  const rank = (v) => { const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let m = i; m <= j; m++) r[idx[m][1]] = avg; i = j + 1; } return r; };
  const rx = rank(xs), ry = rank(ys), n = xs.length, mx = (n + 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - mx); dx += (rx[i] - mx) ** 2; dy += (ry[i] - mx) ** 2; }
  return num / Math.sqrt(dx * dy);
}
const zscore = (v) => { const m = v.reduce((s, x) => s + x, 0) / v.length, sd = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)); return v.map((x) => (x - m) / sd); };

// --------------------------------------------------------------- report ----
const out = [];
const P = (s = "") => out.push(s);
const byBucket = (b) => pop.filter((p) => p.bucket === b);
const stat = (xs, f = fmtH) => xs.length ? `${f(median(xs))} / ${f(pct(xs, 0.9))}` : "—";

P(`## Population (as read)`);
P();
P(`- Query: \`GET /repos/${REPO}/pulls?state=closed&sort=created&direction=desc&per_page=${PER_PAGE}&page=1..${pages}\` → ${closed.length} closed PRs, ${mergedAll.length} merged, ${droppedUnmerged} closed-unmerged dropped; population = the first ${pop.length} merged.`);
P(`- PRs #${first.n}–#${last.n} (numbers are not contiguous: issues interleave), created ${new Date(first.created).toISOString()} → ${new Date(last.created).toISOString()}, merged ${new Date(Math.min(...pop.map((p) => p.merged))).toISOString()} → ${new Date(Math.max(...pop.map((p) => p.merged))).toISOString()}.`);
P(`- Open PRs at read time (\`GET /pulls?state=open\`): ${openNow.items.length}${openNow.items.length ? ` (#${openNow.items.map((p) => p.number).join(", #")})` : " — no still-open PR from the window is missing from the depth count"}.`);
P(`- Buffer (${BUFFER_PAGES} older page${BUFFER_PAGES === 1 ? "" : "s"}, ${buffer.length} merged PRs, #${Math.min(...buffer.map((b) => b.n))}–#${Math.max(...buffer.map((b) => b.n))}): ${buffer.filter((b) => b.merged > first.created).length} of them were still open when the population's first PR arrived; counting them moves ${pop.filter((p) => bucketOf(p.depthBuf) !== p.bucket).length} PRs to a deeper bucket (sensitivity only; every table below uses the ticket's definition).`);
P(`- Arrivals per UTC day: ${[...new Set(pop.map((p) => p.day))].sort().map((d) => `${d}: ${pop.filter((p) => p.day === d).length}`).join(", ")}.`);
const sd = (v) => { const m = v.reduce((s, x) => s + x, 0) / v.length; return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1)); };
P(`- Depth at arrival (population PRs open at each PR's creation): median ${median(pop.map((p) => p.depth))}, p75 ${pct(pop.map((p) => p.depth), 0.75)}, p90 ${pct(pop.map((p) => p.depth), 0.9)}, max ${Math.max(...pop.map((p) => p.depth))}, SD ${sd(pop.map((p) => p.depth)).toFixed(2)}; buckets ${BUCKETS.map((b) => `${b}: ${byBucket(b).length}`).join(", ")}. Same-day arrivals SD ${sd(pop.map((p) => p.sameDay)).toFixed(1)}; arrivals within ±1 h median ${median(pop.map((p) => p.nearby))}, SD ${sd(pop.map((p) => p.nearby)).toFixed(2)}.`);
P(`- Linked issues: ${pop.filter((p) => p.linked.length).length} PRs name \`Closes #m\` (${pop.filter((p) => p.linked.length > 1).length} name more than one); ${pop.filter((p) => !p.linked.length).length} name none. Claim (\`labeled in-progress\` on the linked issue before the PR opened) found for ${pop.filter((p) => p.claim !== null).length}.`);
P(`- Review-side writes: \`/pulls/<n>/reviews\` ${pop.reduce((s, p) => s + p.reviews.length, 0)} across the population, \`/pulls/<n>/comments\` ${pop.reduce((s, p) => s + p.reviewComments.length, 0)}; \`/issues/<n>/comments\` ${pop.reduce((s, p) => s + p.comments.length, 0)}, of which ${pop.reduce((s, p) => s + p.comments.filter((c) => REVIEW_COMMENT.test(c.body) && T(c.created_at) < p.merged).length, 0)} are pre-merge review-side reports (${pop.filter((p) => p.hasReviewComment).length} PRs) and ${pop.reduce((s, p) => s + p.comments.filter((c) => /^Release workflow failed/.test(c.body)).length, 0)} are post-merge \`Release workflow failed\` notices.`);
P(`- \`head_ref_force_pushed\` events: ${pop.reduce((s, p) => s + p.pushCount, 0)} (${pop.filter((p) => p.pushCount).length} PRs); commits authored after PR open: ${pop.reduce((s, p) => s + p.commits.filter((c) => T(c.commit.author.date) > p.created).length, 0)} (${pop.filter((p) => p.commits.some((c) => T(c.commit.author.date) > p.created)).length} PRs), of which ${pop.filter((p) => p.earlyCommit).length} PR${pop.filter((p) => p.earlyCommit).length === 1 ? " has its" : "s have their"} first one under 5 min after open (${pop.filter((p) => p.earlyCommit).map((p) => `#${p.n}`).join(", ") || "none"} — plausibly the implementer's own follow-up rather than a fix-applier's). Where a PR has both a post-open commit and a review-side comment, the comment follows the commit by median ${fmtH(median(pop.filter((p) => p.commentAfterCommit !== null).map((p) => p.commentAfterCommit)))} (p90 ${fmtH(pct(pop.filter((p) => p.commentAfterCommit !== null).map((p) => p.commentAfterCommit), 0.9))}, n=${pop.filter((p) => p.commentAfterCommit !== null).length}).`);
P(`- Comments carrying the ledger's hold/refusal vocabulary (\`held-behind\`, \`conflict-hold\`, \`past-pin\`, \`head-moved-after-label\`, \`label-pulled\`, \`rebase-fallback\`): ${pop.reduce((s, p) => s + p.ledgerVocabComments, 0)}; comments reporting a finisher halt (\`finisher-pr-<n> halted\`): ${pop.reduce((s, p) => s + p.comments.filter((c) => /^finisher-pr-\d+(?:-[a-z])? halted/i.test(c.body)).length, 0)} (${pop.filter((p) => p.comments.some((c) => /^finisher-pr-\d+(?:-[a-z])? halted/i.test(c.body))).map((p) => `#${p.n}`).join(", ") || "none"}). Event actors: ${[...new Set(pop.flatMap((p) => p.events.map((e) => e.actor?.login ?? "null")))].join(", ")}.`);
P();
P(`## Results`);
P();
P(`### First review evidence — which signal won`);
P();
const kinds = ["commit", "comment", "push", "label"];
P(table(["bucket", "n", ...kinds.map((k) => `evidence = ${k}`), "label is the first write (review silent)"],
  [...BUCKETS, "all"].map((b) => { const xs = b === "all" ? pop : byBucket(b); return [b, xs.length, ...kinds.map((k) => xs.filter((p) => p.evidenceKind === k).length), fmtPct(xs.filter((p) => p.evidenceKind === "label").length, xs.length)]; })));
P();
P(`### Stages per depth-at-arrival bucket (median / p90)`);
P();
P(table(["bucket", "n", "cycle created→merged", "(0) Claim→open", "(a) open→evidence", "(b) evidence→first label", "(c) first label→merged", "(c') last label→merged", "(c'') last non-flip label→merged", "churn span first→last label (churned PRs)"],
  [...BUCKETS, "all"].map((b) => { const xs = b === "all" ? pop : byBucket(b); return [b, xs.length,
    stat(xs.map((p) => p.cycle)),
    stat(xs.filter((p) => p.claim !== null).map((p) => p.created - p.claim)),
    stat(xs.filter((p) => p.a !== null).map((p) => p.a)),
    stat(xs.filter((p) => p.b !== null).map((p) => p.b)),
    stat(xs.filter((p) => p.c !== null).map((p) => p.c)),
    stat(xs.filter((p) => p.cPrime !== null).map((p) => p.cPrime)),
    stat(xs.filter((p) => p.cSubst !== null).map((p) => p.cSubst)),
    stat(xs.filter((p) => p.churned).map((p) => p.churnSpan))]; })));
P();
P(`Stage shares of the median cycle, all PRs: (a) ${fmtPct(Math.round(median(pop.filter((p) => p.a !== null).map((p) => p.a)) / MIN), Math.round(median(pop.map((p) => p.cycle)) / MIN))}, (b) ${fmtPct(Math.round(median(pop.filter((p) => p.b !== null).map((p) => p.b)) / MIN), Math.round(median(pop.map((p) => p.cycle)) / MIN))}, (c) ${fmtPct(Math.round(median(pop.filter((p) => p.c !== null).map((p) => p.c)) / MIN), Math.round(median(pop.map((p) => p.cycle)) / MIN))} (medians in minutes; they need not sum to the cycle median).`);
P();
P(`Mean stage minutes per bucket (means do sum): ${BUCKETS.map((b) => { const xs = byBucket(b); const mean = (f) => { const v = xs.map(f).filter((x) => x !== null); return v.reduce((s, x) => s + x, 0) / v.length / MIN; }; return `${b}: cycle ${mean((p) => p.cycle).toFixed(0)} = (a) ${mean((p) => p.a).toFixed(0)} + (b) ${mean((p) => p.b).toFixed(0)} + (c) ${mean((p) => p.c).toFixed(0)}`; }).join("; ")}.`);
P();
P(`### (d) Label churn per bucket`);
P();
P(table(["bucket", "n", "labelled ready-to-merge >1×", "re-pin flips (≤60 s, nothing inside)", "churned PRs (label off >60 s or with a push inside)", "churn windows", "time lost per churned PR (median / p90)", "merged with label off"],
  [...BUCKETS, "all"].map((b) => { const xs = b === "all" ? pop : byBucket(b); return [b, xs.length,
    fmtPct(xs.filter((p) => p.labelCount > 1).length, xs.length),
    `${xs.filter((p) => p.flips.length).length} PRs / ${xs.reduce((s, p) => s + p.flips.length, 0)} flips`,
    fmtPct(xs.filter((p) => p.churned).length, xs.length),
    xs.reduce((s, p) => s + p.churns.length, 0),
    stat(xs.filter((p) => p.churned && p.churnLost > 0).map((p) => p.churnLost)),
    xs.filter((p) => p.churns.some((c) => c.shape === "merged-unlabelled")).length]; })));
P();
const shapes = [...new Set(pop.flatMap((p) => p.churns.map((c) => c.shape)))].sort();
P(`Churn windows by legible shape (all buckets): ${shapes.map((s) => { const ws = pop.flatMap((p) => p.churns.filter((c) => c.shape === s)); return `**${s}** ${ws.length} (PRs #${[...new Set(pop.filter((p) => p.churns.some((c) => c.shape === s)).map((p) => p.n))].join(", #")}; label-off ${ws.filter((w) => w.gap !== null).length ? `median ${fmtH(median(ws.filter((w) => w.gap !== null).map((w) => w.gap)))}` : "n/a"})`; }).join("; ")}.`);
P();
P(`Re-pin flips: ${pop.reduce((s, p) => s + p.flips.length, 0)} in ${pop.filter((p) => p.flips.length).length} PRs; gap median ${(median(pop.flatMap((p) => p.flips.map((f) => f.gap))) / 1e3).toFixed(0)} s, max ${(Math.max(0, ...pop.flatMap((p) => p.flips.map((f) => f.gap))) / 1e3).toFixed(0)} s; ${pop.flatMap((p) => p.flips).filter((f) => f.pushBefore).length} follow a push that landed after the previous label (the merge bot's own rebase, by its committer dates); the flip precedes the merge by median ${fmtH(median(pop.flatMap((p) => p.flips.map((f) => p.merged - f.relabel))))}.`);
P();
P(`### (c) against the queue ahead`);
P();
const qa = (lo, hi) => pop.filter((p) => p.c !== null && p.lowerOpenAtLabel >= lo && p.lowerOpenAtLabel <= hi);
P(table(["lower-numbered population PRs still open at first label", "n", "(c) first label→merged median / p90", "(c'') last non-flip label→merged median / p90", "churned", "depth-at-arrival median"],
  [[0, 0], [1, 2], [3, 5], [6, Infinity]].map(([lo, hi]) => { const xs = qa(lo, hi); return [hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}-${hi}`, xs.length, stat(xs.map((p) => p.c)), stat(xs.map((p) => p.cSubst)), fmtPct(xs.filter((p) => p.churned).length, xs.length), median(xs.map((p) => p.depth))]; })));
P();
P(`Spearman(lower open at first label, (c)): ${spearman(pop.filter((p) => p.c !== null).map((p) => p.lowerOpenAtLabel), pop.filter((p) => p.c !== null).map((p) => p.c)).toFixed(2)}; Spearman(depth at arrival, (c)): ${spearman(pop.filter((p) => p.c !== null).map((p) => p.depth), pop.filter((p) => p.c !== null).map((p) => p.c)).toFixed(2)}; Spearman(depth at arrival, lower open at first label): ${spearman(pop.filter((p) => p.c !== null).map((p) => p.depth), pop.filter((p) => p.c !== null).map((p) => p.lowerOpenAtLabel)).toFixed(2)}.`);
P();
P(`### Depth or busy day?`);
P();
const days = [...new Set(pop.map((p) => p.day))].sort();
P(table(["UTC day", "arrivals", "depth median", ...BUCKETS.map((b) => `cycle median @${b} (n)`), "Spearman(depth, cycle) within day", "PRs with a fix-applier comment"],
  days.map((d) => { const xs = pop.filter((p) => p.day === d); return [d, xs.length, median(xs.map((p) => p.depth)), ...BUCKETS.map((b) => { const ys = xs.filter((p) => p.bucket === b); return ys.length ? `${fmtH(median(ys.map((p) => p.cycle)))} (${ys.length})` : "— (0)"; }), xs.length > 3 ? spearman(xs.map((p) => p.depth), xs.map((p) => p.cycle)).toFixed(2) : "—", xs.filter((p) => p.hasReviewComment).length]; })));
P();
const y = pop.map((p) => Math.log(hours(p.cycle)));
const zDepth = zscore(pop.map((p) => p.depth)), zSame = zscore(pop.map((p) => p.sameDay)), zNear = zscore(pop.map((p) => p.nearby));
const m1 = ols(y, zDepth.map((v) => [v])), m2 = ols(y, zSame.map((v) => [v])), m3 = ols(y, pop.map((_, i) => [zDepth[i], zSame[i]])), m4 = ols(y, zNear.map((v) => [v])), m5 = ols(y, pop.map((_, i) => [zDepth[i], zNear[i]]));
const fm = (m, names) => names.map((nm, i) => `${nm} β=${m.beta[i + 1].toFixed(3)} (t=${m.t[i + 1].toFixed(1)})`).join(", ") + `; R²=${m.r2.toFixed(3)}`;
P(`OLS of log(cycle hours) on standardised predictors (β = change in log-hours per 1 SD; n=${pop.length}):`);
P();
P(`- depth at arrival alone: ${fm(m1, ["depth"])}`);
P(`- same-UTC-day arrivals alone: ${fm(m2, ["same-day"])}`);
P(`- both: ${fm(m3, ["depth", "same-day"])}`);
P(`- arrivals within ±1 h alone: ${fm(m4, ["±1 h"])}`);
P(`- depth + arrivals within ±1 h: ${fm(m5, ["depth", "±1 h"])}`);
P(`- Spearman(depth, cycle) all PRs: ${spearman(pop.map((p) => p.depth), pop.map((p) => p.cycle)).toFixed(2)}; Spearman(same-day arrivals, cycle): ${spearman(pop.map((p) => p.sameDay), pop.map((p) => p.cycle)).toFixed(2)}; Spearman(depth, same-day arrivals): ${spearman(pop.map((p) => p.depth), pop.map((p) => p.sameDay)).toFixed(2)}.`);
P();
const stageReg = (name, f) => { const xs = pop.filter((p) => f(p) !== null && f(p) > 0); const yy = xs.map((p) => Math.log(hours(f(p)))); const m = ols(yy, xs.map((p) => [zDepth[pop.indexOf(p)], zSame[pop.indexOf(p)]])); return `${name}: ${fm(m, ["depth", "same-day"])} (n=${xs.length})`; };
P(`Per stage, log-hours on depth + same-day arrivals: ${[stageReg("(a)", (p) => p.a), stageReg("(b)", (p) => p.b), stageReg("(c)", (p) => p.c)].join("; ")}.`);
P();
P(`### Within-day stage medians (days with ≥ 30 arrivals)`);
P();
P(table(["UTC day", "bucket", "n", "cycle", "(a) open→evidence", "(b) evidence→first label", "(c) first label→merged", "(c') last label→merged", "churned"],
  days.filter((d) => pop.filter((p) => p.day === d).length >= 30).flatMap((d) => BUCKETS.map((b) => { const xs = pop.filter((p) => p.day === d && p.bucket === b); return xs.length ? [d, b, xs.length, stat(xs.map((p) => p.cycle)), stat(xs.filter((p) => p.a !== null).map((p) => p.a)), stat(xs.filter((p) => p.b !== null).map((p) => p.b)), stat(xs.filter((p) => p.c !== null).map((p) => p.c)), stat(xs.filter((p) => p.cPrime !== null).map((p) => p.cPrime)), fmtPct(xs.filter((p) => p.churned).length, xs.length)] : null; }).filter(Boolean))));
P();
P(`### Dormancy removed: the same stages in fleet-live time`);
P();
P(`Tracker writes on population PRs: ${writes.length}; inter-write gaps above ${DORMANT_AFTER / MIN} min: ${dormant.length}, dormant time ${hours(dormantTotal).toFixed(1)} h of the window's ${hours(last.merged - first.created).toFixed(1)} h (${dormant.map(([a, b]) => `${new Date(a - DORMANT_AFTER).toISOString().slice(5, 16).replace("T", " ")}+${((b - a) / MIN).toFixed(0)} min`).join(", ")}). PRs whose interval crosses a dormant stretch: ${pop.filter((p) => p.dormantHit).length} (${BUCKETS.map((b) => `${b}: ${byBucket(b).filter((p) => p.dormantHit).length}/${byBucket(b).length}`).join(", ")}).`);
P();
P(table(["bucket", "n", "live cycle", "live (a)", "live (b)", "live (c)", "wall cycle (for reference)"],
  [...BUCKETS, "all"].map((b) => { const xs = b === "all" ? pop : byBucket(b); return [b, xs.length, stat(xs.map((p) => p.cycleLive)), stat(xs.filter((p) => p.aLive !== null).map((p) => p.aLive)), stat(xs.filter((p) => p.bLive !== null).map((p) => p.bLive)), stat(xs.filter((p) => p.cLive !== null).map((p) => p.cLive)), stat(xs.map((p) => p.cycle))]; })));
P();
P(`Mean live stage minutes per bucket (means do sum): ${BUCKETS.map((b) => { const xs = byBucket(b); const mean = (f) => { const v = xs.map(f).filter((x) => x !== null); return v.reduce((s, x) => s + x, 0) / v.length / MIN; }; return `${b}: live cycle ${mean((p) => p.cycleLive).toFixed(0)} = (a) ${mean((p) => p.aLive).toFixed(0)} + (b) ${mean((p) => p.bLive).toFixed(0)} + (c) ${mean((p) => p.cLive).toFixed(0)}`; }).join("; ")}.`);
P();
const yl = pop.map((p) => Math.log(Math.max(hours(p.cycleLive), 1 / 60)));
const l1 = ols(yl, zDepth.map((v) => [v])), l2 = ols(yl, zSame.map((v) => [v])), l3 = ols(yl, pop.map((_, i) => [zDepth[i], zSame[i]])), l4 = ols(yl, pop.map((_, i) => [zDepth[i], zNear[i]]));
P(`OLS of log(live cycle hours): depth alone ${fm(l1, ["depth"])}; same-day alone ${fm(l2, ["same-day"])}; both ${fm(l3, ["depth", "same-day"])}; depth + ±1 h arrivals ${fm(l4, ["depth", "±1 h"])}. Spearman(depth, live cycle) all PRs: ${spearman(pop.map((p) => p.depth), pop.map((p) => p.cycleLive)).toFixed(2)}; within day: ${days.map((d) => { const xs = pop.filter((p) => p.day === d); return `${d} ${xs.length > 3 ? spearman(xs.map((p) => p.depth), xs.map((p) => p.cycleLive)).toFixed(2) : "—"}`; }).join(", ")}.`);
P();
const stageRegLive = (name, f) => { const xs = pop.filter((p) => f(p) !== null && f(p) > 0); const yy = xs.map((p) => Math.log(hours(f(p)))); const m = ols(yy, xs.map((p) => [zDepth[pop.indexOf(p)], zSame[pop.indexOf(p)]])); return `${name}: ${fm(m, ["depth", "same-day"])} (n=${xs.length})`; };
P(`Per stage in live time, log-hours on depth + same-day arrivals: ${[stageRegLive("(a)", (p) => p.aLive), stageRegLive("(b)", (p) => p.bLive), stageRegLive("(c)", (p) => p.cLive)].join("; ")}.`);
P();
P(`Live (c) against the queue ahead: ${[[0, 0], [1, 2], [3, 5], [6, Infinity]].map(([lo, hi]) => { const xs = qa(lo, hi); return `${hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}-${hi}`} lower open → ${stat(xs.map((p) => p.cLive))} (n=${xs.length})`; }).join("; ")}.`);
P();
P(`### Per-PR rows`);
P();
P(`<details><summary>${pop.length} rows: PR, created (UTC), depth, bucket, same-day arrivals, cycle h, live cycle h, (0) claim→open h, (a) h, (b) h, (c) h, (c'') h, evidence kind, ready-to-merge label count, re-pin flips, churn windows (shape:gap min), lower-numbered PRs open at first label</summary>`);
P();
P(table(["PR", "created", "depth", "bucket", "same-day", "cycle", "live cycle", "(0)", "(a)", "(b)", "(c)", "(c'')", "evidence", "labels", "flips", "churn", "lower@label"],
  pop.map((p) => [`#${p.n}`, new Date(p.created).toISOString().slice(5, 16).replace("T", " "), p.depth, p.bucket, p.sameDay, hours(p.cycle).toFixed(2), hours(p.cycleLive).toFixed(2),
    p.claim !== null ? hours(p.created - p.claim).toFixed(2) : "—", p.a !== null ? hours(p.a).toFixed(2) : "—", p.b !== null ? hours(p.b).toFixed(2) : "—", p.c !== null ? hours(p.c).toFixed(2) : "—", p.cSubst !== null ? hours(p.cSubst).toFixed(2) : "—",
    p.evidenceKind ?? "—", p.labelCount, p.flips.length, p.churns.map((c) => `${c.shape}:${c.gap === null ? "∞" : (c.gap / MIN).toFixed(0)}`).join(" ") || "—", p.lowerOpenAtLabel ?? "—"])));
P();
P(`</details>`);
console.log(out.join("\n"));
