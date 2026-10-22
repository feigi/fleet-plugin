#!/usr/bin/env node
// ADR 0031's guard as a script: the pre and post windows around the In-flight
// bound's tick change, the per-test band from the slot loop's own history, and
// the six verdicts. Spec: docs/specs/2026-10-13-in-flight-bound-design.md § 8;
// ADR 0031 § Guard.
//
//   node docs/research/in-flight-guard-derive.mjs --merge <ISO> [--cutover <ISO>]
//        [--after 2026-09-25T18:58:33Z] [--n 20] [--offset 5]
//        [--repo feigi/fleet-plugin] [--cache DIR] [--refresh]
//        [--transport auto|gh|curl] [--no-token]
//        [--member-outcomes docs/metrics/member-outcomes.tsv]
//        [--sessions ~/.omp/agent/sessions/-dev-fleet-plugin] [--json FILE]
//
//   --merge ISO       required. The `mergedAt` of the ticket that changes which
//                     PRs get Pulled (the tick ticket):
//                       gh pr view <its PR> --json mergedAt -q .mergedAt
//                     Pre window = the --n merged PRs created most recently
//                     BEFORE it. The history the band comes from ends here.
//   --cutover ISO     the cutover instant. Post window = the first --n merged
//                     PRs created at or after it, earliest first (the
//                     baseline's `--after ISO --n N` semantics). PRs created
//                     between --merge and --cutover are in neither window.
//                     Omitted: no windows and no verdict; the history's ratio
//                     series and the six bands are printed alone, exit 0.
//   --after ISO       start of the slot-loop history (default
//                     2026-09-25T18:58:33Z, the baseline note's first creation).
//   --n N             window size (default 20).
//   --offset K        stride between the history's pairs (default 5). A pair is
//                     the N merged PRs at positions s … s+N-1 of the history and
//                     the N at s+N … s+2N-1, for s = 0, K, 2K, …: disjoint,
//                     adjoining windows, the shape of the pre and post
//                     windows. Successive pairs start K PRs apart. This is the
//                     construction spec § 8.2 defines and ADR 0031's Status
//                     amendment records for § Guard; on 2026-10-09's history
//                     it gives 79 pairs and the published ×2.23 cycle / ×0.68
//                     throughput band.
//   --member-outcomes the signal 1 / 4 input (default docs/metrics/
//                     member-outcomes.tsv beside this script's repo root).
//                     Step 0 of every reading: re-scrape it first with
//                     plugin/scripts/member-outcomes.mjs.
//   --sessions DIR    the signal 2 input and the /run-team session count (default
//                     ~/.omp/agent/sessions/-dev-fleet-plugin). A DIR that
//                     does not exist is an input error when named, and reads as
//                     "no controller transcripts" when it is the default.
//   --json FILE       also write the computed report as JSON.
//   --repo, --cache, --refresh, --transport, --no-token  the GitHub read the
//                     baseline script shares (in-flight-github-read.mjs): `gh
//                     api` else `curl`, a list complete only when its last page
//                     is shorter than per_page, a cache dir inside a git
//                     checkout refused. The default cache is the baseline's.
//
// WHERE THE CUTOVER COMES FROM (spec § 8.3). The cutover is the first
// timestamp in the omp session file of the first `/run-team` whose phase-0
// pin includes the merge: the first line carrying a string `timestamp`,
//   jq -r 'select(.timestamp != null) | .timestamp' <file> | head -1
// A `/run-team` session is a file `<ISO-with-dashes>_<id>.jsonl` directly under
// ~/.omp/agent/sessions/-dev-fleet-plugin/ with a user turn beginning
// `/run-team`, `/skill:run-team` or `/fleet-ctl:run-team`. Take them in order
// of start and keep the first whose phase-0 evidence includes the merge: its
// `git merge --ff-only origin/main` (or a `git rev-list --count
// main..origin/main` of 0 after the fetch) and its `instruments.sh --pin` tool
// results precede its first `ledger.mjs dispatch`, and the main it
// fast-forwarded to contains the merge commit (`git merge-base --is-ancestor
// <merge-sha> <that HEAD>`). A run that started before the merge, or
// fast-forwarded to a main without it, is skipped: it belongs to neither
// window. This script takes the instant; it does not pick the session.
//
// THE SIX TESTS. Each is post ÷ pre over the two windows, tripped when the
// ratio lands PAST the one-sided band of the history's pair ratios (the later
// window ÷ the earlier one of each pair): above the p90 for a "must not rise"
// test, below the p10 for the "must not fall" one (the linear-interpolation
// percentile the baseline's pct() uses).
//   1   fleet cache_creation per merged PR   Σ tokens_cache_create over the
//       member-outcomes.tsv rows booked to the window's PRs ÷ N. Booked by
//       this script's own PR join, not pr-cost.mjs's Pull booking: omp rows
//       only; a member whose name's last segment pull-attribution.mjs's
//       EXCLUDED_MEMBER matches is booked nowhere, and so is any row whose
//       role is `memory`; a member whose name carries the PR
//       (parseMemberName) books to it, an implementer row books to the PR
//       whose body closes its `ticket` (a closing keyword before `#<n>`, the
//       one place the REST pulls list carries it), and every member nested
//       under a booked one books to it.                                  rise
//   2   controller cache_creation per merged PR   Σ usage.cacheWrite over the
//       top-level assistant turns of the `/run-team` session files under
//       --sessions (never a file in a session's subagent directory) dated
//       within the window's created span ÷ N.                            rise
//   3a  cycle time created → merged, median.                             rise
//   3b  merged PRs per active clock hour: N ÷ the distinct UTC hours in which
//       a window PR was created or merged (the baseline's primary
//       definition).                                                     fall
//   4a  review start latency, median: the `review-pr-<n>` member's first
//       transcript timestamp (its session_init), found through the row's
//       `session` and `agent` columns under --sessions, minus the PR's
//       created_at; PRs with no readable review row are listed and
//       excluded.                                                        rise
//   4b  the same, p90.                                                   rise
//
// Exit codes (pr-cost's guard vocabulary): 0 no test tripped; 3 at least one
// tripped (`tripped[]` names each); 4 no verdict — a pre or post window shorter
// than N, fewer than two `/run-team` sessions among the post window's PRs, or a test with no
// reading because member-outcomes.tsv or the session files lack rows for the
// window or the history (step 0 undone). A trip that was read is still printed
// under exit 4, but the verdict is withheld. 2 input error (a bad ISO, a
// cutover before the merge, an untrusted GitHub page, an unreadable input):
// nothing printed as a verdict. `--merge` alone exits 0 once the cycle and
// throughput bands exist, else 4.
//
// THEN, what each trip revisits first (ADR 0031 § Guard), printed beside the
// verdict:
//   3b throughput falls  the default bound first (at B = 5, 68 % of past Pulls
//      would have been held), then the definition of In flight (held and
//      halted PRs taking slots, decision 3). Never the hold's rank.
//   3a cycle rises       re-run docs/research/in-flight-cycle-time-stages-
//      derive.mjs on both windows. A rise in first `ready-to-merge` → merged
//      belongs to ADR 0007 guard 1 (the merge side, outside ADR 0031). A rise
//      in Claim → open, open → review evidence, or evidence → label revisits
//      the default bound.
//   1  signal 1 rises    the default bound first (it is the load lever), then
//      ADR 0012's existing order: merges per pass, then the bot's brief size.
//   2  signal 2 rises    unchanged: the per-Pull prompt.
//   4a, 4b signal 4 rises  the reviewer row's uncapped dispatch first (decision
//      5), then the operator's `task.maxConcurrency`, which the phase-0 notice
//      already reports (decision 7).
//   Do not read a trip as licence to reintroduce staging or the implementer and
//   reviewer caps: automatic supply is ADR 0013's own decision, and ADR 0031's
//   bound is the cap's replacement.
//
// Every table the script prints names the query that produced it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeDie, defineFlags } from "../../plugin/scripts/arg.mjs";
import { isCLI } from "../../plugin/scripts/is-cli.mjs";
import { parseMemberName } from "../../plugin/scripts/member-record.mjs";
import { parseTsv as parseMemberTsv } from "../../plugin/scripts/member-outcomes.mjs";
import { EXCLUDED_MEMBER, lastSegment } from "../../plugin/scripts/pull-attribution.mjs";
import { DEFAULT_CACHE, PER_PAGE, describeTransport, openGithubRead } from "./in-flight-github-read.mjs";

const NAME = "in-flight-guard";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const H = 3600_000, MIN = 60_000;
export const EXIT = { ok: 0, tripped: 3, none: 4, input: 2 };
export const DEFAULTS = {
  after: "2026-09-25T18:58:33Z", n: 20, offset: 5, repo: "feigi/fleet-plugin",
  memberOutcomes: path.join(HERE, "..", "metrics", "member-outcomes.tsv"),
  sessions: path.join(os.homedir(), ".omp", "agent", "sessions", "-dev-fleet-plugin"),
};

const REVIEW_THEN = "the reviewer row's uncapped dispatch first (decision 5), then the operator's task.maxConcurrency, which the phase-0 notice already reports (decision 7)";

/** The six tests, in the ADR's order. `dir` is the direction the band trips on. */
export const TESTS = [
  { id: "1", label: "fleet cache_creation per merged PR", dir: "rise",
    then: "the default bound first (it is the load lever), then ADR 0012's existing order: merges per pass, then the bot's brief size" },
  { id: "2", label: "controller cache_creation per merged PR", dir: "rise",
    then: "unchanged: the per-Pull prompt" },
  { id: "3a", label: "cycle time created→merged, median", dir: "rise",
    then: "re-run docs/research/in-flight-cycle-time-stages-derive.mjs on both windows; a rise in first ready-to-merge → merged belongs to ADR 0007 guard 1 (the merge side, outside ADR 0031); a rise in Claim → open, open → review evidence, or evidence → label revisits the default bound" },
  { id: "3b", label: "merged PRs per active clock hour", dir: "fall",
    then: "the default bound first (at B = 5, 68 % of past Pulls would have been held), then the definition of In flight (held and halted PRs taking slots, decision 3); never the hold's rank" },
  { id: "4a", label: "review start latency, median", dir: "rise", then: REVIEW_THEN },
  { id: "4b", label: "review start latency, p90", dir: "rise", then: REVIEW_THEN },
];
const NO_LICENCE = "Do not read a trip as licence to reintroduce staging or the implementer and reviewer caps: automatic supply is ADR 0013's own decision, and ADR 0031's bound is the cap's replacement.";

/** A refusal the CLI turns into exit 2; the pure functions throw it. */
export class InputError extends Error {}

// ------------------------------------------------------------ statistics ----
export const sortedNum = (xs) => xs.slice().sort((a, b) => a - b);
/** Linear interpolation on sorted data, as the baseline's pct(). */
export function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const k = (sorted.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}
export const median = (xs) => pct(sortedNum(xs), 0.5);

// ---------------------------------------------------------------- input ----
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
export function parseIso(value, what) {
  if (typeof value !== "string" || !ISO_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new InputError(`${what} must be an ISO-8601 instant like 2026-10-09T12:00:00Z, got ${JSON.stringify(value)}`);
  }
  return Date.parse(value);
}

const CLOSING_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/gi;
/** The issue numbers a PR body closes with a closing keyword. */
export function closingIssues(body) {
  return [...new Set([...String(body ?? "").matchAll(CLOSING_RE)].map((m) => m[1]))];
}

/**
 * Merged PRs out of a REST pulls list, oldest created first (ties by number).
 * A PR the listing returns on two pages counts once, as its last-read copy.
 */
export function mergedPrs(pulls) {
  const latest = new Map();
  for (const p of pulls) latest.set(p.number, p);
  const out = [];
  for (const p of latest.values()) {
    if (!p.merged_at) continue;
    const created = Date.parse(p.created_at), merged = Date.parse(p.merged_at);
    if (Number.isNaN(created) || Number.isNaN(merged)) throw new InputError(`PR #${p.number} lacks a parseable created_at/merged_at`);
    out.push({ number: p.number, created, merged, closes: closingIssues(p.body) });
  }
  return out.sort((a, b) => a.created - b.created || a.number - b.number);
}

/** The ticket → PR booking map: the latest-created merged PR whose body closes the ticket. */
export function prByTicket(prs) {
  const m = new Map();
  for (const p of prs) for (const t of p.closes) m.set(t, p.number);
  return m;
}

// -------------------------------------------------------------- windows ----
/**
 * Cut the history, the pre window and the post window out of merged PRs
 * (oldest created first). A PR created between `merge` and `cutover` is in
 * neither window; the history is the PRs created in [after, merge).
 */
export function cutWindows(prs, { merge, cutover = null, after, n }) {
  const history = prs.filter((p) => p.created >= after && p.created < merge);
  const pre = prs.filter((p) => p.created < merge).slice(-n);
  const post = cutover === null ? null : prs.filter((p) => p.created >= cutover).slice(0, n);
  return { history, pre, post };
}

/**
 * The history's pairs of adjoining windows: for each start s = 0, K, 2K, …, the
 * `early` window of the `n` PRs at positions s … s+n-1 and the `late` one at
 * s+n … s+2n-1, while both fit. A pair is the shape of the pre and post
 * windows (disjoint, one after the other); successive pairs start K PRs apart.
 */
export function historyPairs(history, n, offset) {
  const out = [];
  for (let s = 0; s + 2 * n <= history.length; s += offset) out.push({ early: history.slice(s, s + n), late: history.slice(s + n, s + 2 * n) });
  return out;
}

const hourKey = (t) => Math.floor(t / H);
export const activeHours = (win) => new Set(win.flatMap((p) => [hourKey(p.created), hourKey(p.merged)])).size;
export const cycleMedian = (win) => median(win.map((p) => p.merged - p.created));
export const throughput = (win) => (win.length ? win.length / activeHours(win) : NaN);

// -------------------------------------------------------------- booking ----
/**
 * Book member-outcomes rows to PRs: a PR-named member to its PR, an
 * implementer to the PR closing its ticket, a nested member with its nearest
 * booked ancestor. Returns the rows per PR number and the omp rows booked
 * nowhere. `byTicket` maps a ticket to the PR that closes it.
 */
export function bookRows(rows, byTicket) {
  const key = (session, agent) => `${session}\0${agent}`;
  const omp = rows.filter((r) => r.harness === "omp" && r.role !== "memory" && !EXCLUDED_MEMBER.test(lastSegment(r.member)));
  const keyed = new Map(); // member key -> PR number
  for (const r of omp) {
    const named = parseMemberName(r.member).pr;
    if (named) keyed.set(key(r.session, r.agent), Number(named));
    else if (r.role === "implementer" && r.ticket && byTicket.has(r.ticket)) keyed.set(key(r.session, r.agent), byTicket.get(r.ticket));
  }
  const byPr = new Map(), unbooked = [];
  for (const r of omp) {
    const segs = String(r.agent).split("/");
    let pr = null;
    for (let i = segs.length; i > 0 && pr === null; i--) pr = keyed.get(key(r.session, segs.slice(0, i).join("/"))) ?? null;
    if (pr === null) { unbooked.push(r); continue; }
    if (!byPr.has(pr)) byPr.set(pr, []);
    byPr.get(pr).push(r);
  }
  return { byPr, unbooked };
}

const REVIEW_AGENT_RE = /^review-pr-(\d+)(?:-\d+)?$/i;
/** The PR a top-level review workflow row belongs to, else null. */
export const reviewPr = (row) => (row.harness === "omp" ? REVIEW_AGENT_RE.exec(String(row.agent))?.[1] ?? null : null);

// ------------------------------------------------------------- sessions ----
const RUN_TEAM_RE = /^\s*\/(?:skill:|fleet-ctl:)?run-team\b/;
/**
 * Fold one omp session file's text: its first and last `timestamp`, whether a
 * user turn begins `/run-team`, and its top-level assistant turns' cacheWrite
 * as [ms, cacheWrite] pairs.
 */
export function scanSession(text) {
  let start = null, end = null, runTeam = false, bad = 0;
  const turns = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { bad++; continue; }
    if (typeof d?.timestamp === "string") { start ??= Date.parse(d.timestamp); end = Date.parse(d.timestamp); }
    const m = d?.type === "message" ? d.message : null;
    if (!m || typeof m !== "object") continue;
    if (m.role === "user" && !runTeam) {
      const parts = typeof m.content === "string" ? [m.content] : Array.isArray(m.content) ? m.content.map((c) => (c?.type === "text" ? c.text : "")) : [];
      runTeam = parts.some((t) => typeof t === "string" && RUN_TEAM_RE.test(t));
    } else if (m.role === "assistant" && m.usage && typeof d.timestamp === "string") {
      turns.push([Date.parse(d.timestamp), Number(m.usage.cacheWrite) || 0]);
    }
  }
  return { start, end, runTeam, turns, bad };
}

/** The `/run-team` sessions among scanned ones whose [start, end] holds a window PR's creation. */
export function sessionsSpanned(win, sessions) {
  return sessions.filter((s) => s.runTeam && s.start !== null && win.some((p) => p.created >= s.start && p.created <= s.end)).map((s) => s.stem);
}

// -------------------------------------------------------------- signals ----
/**
 * The six values of one window of PRs, NaN where the inputs hold no reading,
 * with the diagnostics a reader needs to judge them.
 * `ctx`: { bookings: Map<pr, row[]>, turns: [ms, cacheWrite][], reviewStarts: Map<pr, ms> }.
 */
export function windowValues(win, ctx) {
  const n = win.length;
  const rows = win.flatMap((p) => ctx.bookings.get(p.number) ?? []);
  const lo = Math.min(...win.map((p) => p.created)), hi = Math.max(...win.map((p) => p.created));
  const inSpan = ctx.turns.filter(([t]) => t >= lo && t <= hi);
  const latencies = win.filter((p) => ctx.reviewStarts.has(p.number)).map((p) => ctx.reviewStarts.get(p.number) - p.created);
  const sorted = sortedNum(latencies);
  return {
    values: {
      "1": rows.length ? rows.reduce((s, r) => s + (Number(r.tokensCacheCreate) || 0), 0) / n : NaN,
      "2": inSpan.length ? inSpan.reduce((s, [, w]) => s + w, 0) / n : NaN,
      "3a": cycleMedian(win),
      "3b": throughput(win),
      "4a": pct(sorted, 0.5),
      "4b": pct(sorted, 0.9),
    },
    diag: {
      booked_rows: rows.length,
      unbooked_prs: win.filter((p) => !ctx.bookings.has(p.number)).map((p) => p.number),
      unpriced_rows: rows.filter((r) => r.cost === "").length,
      controller_turns: inSpan.length,
      review_prs: latencies.length,
      no_review_prs: win.filter((p) => !ctx.reviewStarts.has(p.number)).map((p) => p.number),
    },
  };
}

/** Late ÷ early, NaN unless both are finite and the earlier one is above zero. */
const ratioOf = (early, late) => (Number.isFinite(early) && Number.isFinite(late) && early > 0 ? late / early : NaN);

/** Late ÷ early over pairs of values, skipping a pair with no reading. */
export function ratioSeries(pairs) {
  return pairs.map(([early, late]) => ratioOf(early, late)).filter(Number.isFinite);
}

/** The one-sided band: p90 for a "must not rise" test, p10 for "must not fall". NaN with no ratios. */
export function band(ratios, dir) {
  return pct(sortedNum(ratios), dir === "fall" ? 0.1 : 0.9);
}

/**
 * One verdict per test. Trips only PAST the band (strictly): above it for a
 * rise test, below it for a fall test. `none` when the ratio or the band has no reading.
 */
export function verdicts(pre, post, bands) {
  return TESTS.map((t) => {
    const ratio = ratioOf(pre[t.id], post[t.id]);
    const b = bands[t.id];
    let verdict = "none";
    if (Number.isFinite(ratio) && Number.isFinite(b)) verdict = (t.dir === "fall" ? ratio < b : ratio > b) ? "TRIP" : "ok";
    return { id: t.id, label: t.label, dir: t.dir, pre: pre[t.id], post: post[t.id], ratio, band: b, verdict };
  });
}

const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const range = (win) => ({
  n: win.length,
  numbers: win.length ? [Math.min(...win.map((p) => p.number)), Math.max(...win.map((p) => p.number))] : null,
  created: win.length ? [iso(Math.min(...win.map((p) => p.created))), iso(Math.max(...win.map((p) => p.created)))] : null,
  prs: win.map((p) => p.number),
});

/**
 * The whole computation over inputs already read: merged PRs, member-outcomes
 * rows, scanned sessions and the review starts. Pure.
 */
export function analyze({ prs, merge, cutover = null, after, n, offset, rows, sessions, reviewStarts }) {
  if (cutover !== null && cutover < merge) throw new InputError("--cutover is before --merge: the cutover is the start of a /run-team that pins the merge");
  const { history, pre, post } = cutWindows(prs, { merge, cutover, after, n });
  const ctx = {
    bookings: bookRows(rows, prByTicket(prs)).byPr,
    turns: sessions.filter((s) => s.runTeam).flatMap((s) => s.turns),
    reviewStarts,
  };
  const pairs = historyPairs(history, n, offset).map(({ early, late }) => [windowValues(early, ctx).values, windowValues(late, ctx).values]);
  const bands = {}, used = {};
  for (const t of TESTS) {
    const ratios = ratioSeries(pairs.map(([a, b]) => [a[t.id], b[t.id]]));
    bands[t.id] = band(ratios, t.dir);
    used[t.id] = ratios.length;
  }
  const report = {
    n, offset, after: iso(after), merge: iso(merge),
    cutover: cutover === null ? null : iso(cutover),
    history: { prs: history.length, pairs: pairs.length, range: range(history) },
    bands, pairs: used, pre: null, post: null, verdicts: null, tripped: [], no_verdict: [], exit: EXIT.ok,
  };
  if (cutover === null) {
    // No windows and no verdict: the band for the cycle and throughput tests is the reading.
    report.exit = Number.isFinite(bands["3a"]) && Number.isFinite(bands["3b"]) ? EXIT.ok : EXIT.none;
    if (report.exit === EXIT.none) report.no_verdict.push(`the history holds fewer than ${2 * n} merged PRs, so no pair of windows exists`);
    return report;
  }
  const preV = windowValues(pre, ctx), postV = windowValues(post, ctx);
  const spanned = sessionsSpanned(post, sessions);
  report.pre = { ...range(pre), ...preV };
  report.post = { ...range(post), ...postV, run_team_sessions: spanned };
  report.verdicts = verdicts(preV.values, postV.values, bands);
  report.tripped = report.verdicts.filter((v) => v.verdict === "TRIP").map((v) => v.id);
  if (pre.length < n) report.no_verdict.push(`the pre window holds ${pre.length} merged PRs, fewer than ${n}`);
  if (post.length < n) report.no_verdict.push(`the post window holds ${post.length} merged PRs, fewer than ${n}`);
  if (spanned.length < 2) report.no_verdict.push(`the post window spans ${spanned.length} /run-team session(s), fewer than 2`);
  for (const v of report.verdicts) {
    if (v.verdict === "none") report.no_verdict.push(`test ${v.id} has no reading (${Number.isFinite(v.ratio) ? "no band: the history holds no pair with rows" : "a window lacks rows"})`);
  }
  report.exit = report.no_verdict.length ? EXIT.none : report.tripped.length ? EXIT.tripped : EXIT.ok;
  return report;
}

// ----------------------------------------------------------- GitHub read ----
/**
 * Page the closed-PR listing newest-created-first until the history and the
 * pre window are in hand: every PR created at or after `after` (the page that
 * crosses `after` ends the read) and at least `n` merged PRs created before
 * `merge`. A listing is complete only when its last page is shorter than per_page.
 */
export function readPulls(listPage, query, { after, merge, n }) {
  const seen = [];
  let pages = 0, ended = false;
  for (;;) {
    pages++;
    const page = listPage(query, pages);
    seen.push(...page);
    if (page.length < PER_PAGE) { ended = true; break; }
    const crossed = Date.parse(page[page.length - 1].created_at) < after;
    const preMerged = seen.filter((p) => p.merged_at && Date.parse(p.created_at) < merge).length;
    if (crossed && preMerged >= n) break;
    if (pages > 200) throw new InputError("more than 200 pages read; refusing to continue");
  }
  return { seen, pages, ended };
}

/**
 * When the listing was read from GitHub: the earliest and the latest read
 * instant among the cached envelopes of `query`'s pages, or null with none.
 * `fetchedAt` is the shared read's apiPath → ISO instant map.
 */
export function listingReads(fetchedAt, query) {
  const reads = [...fetchedAt].filter(([k]) => k.startsWith(query)).map(([, v]) => v).sort();
  return reads.length ? { first: reads[0], last: reads[reads.length - 1] } : null;
}

/**
 * The warning a cached listing earns, or null: some page was read more than a
 * day before `now`, or before `cutover` (such a page cannot hold a PR created
 * after the cutover). The baseline script's own 24 h rule.
 */
export function staleWarning(reads, { now, cutover = null }) {
  if (reads === null) return null;
  const first = Date.parse(reads.first);
  if (cutover !== null && first < cutover) return `a listing page was read at ${reads.first}, before --cutover ${iso(cutover)}; pass --refresh (or a fresh --cache dir) to read today's pages`;
  if (now - first > 24 * H) return `a cached listing page was read at ${reads.first}; pass --refresh (or a fresh --cache dir) to read today's pages`;
  return null;
}

// ------------------------------------------------------- file-system read ----
const SESSION_FILE_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_[0-9a-f-]+\.jsonl$/i;
/** Scan every `/run-team`-candidate session file directly under `dir` that began by `until`. */
export function readSessions(dir, until = Infinity) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const m = SESSION_FILE_RE.exec(e.name);
    if (!m || !(e.isFile() || e.isSymbolicLink())) continue;
    if (Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) > until) continue;
    out.push({ stem: e.name.replace(/\.jsonl$/, ""), ...scanSession(fs.readFileSync(path.join(dir, e.name), "utf8")) });
  }
  return out;
}

/** The first string `timestamp` of a transcript — its session_init — or null. */
export function firstTimestamp(file) {
  let fd;
  try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(64 * 1024);
    let text = "", at = 0;
    for (;;) {
      const got = fs.readSync(fd, buf, 0, buf.length, at);
      if (got === 0) break;
      at += got;
      text += buf.toString("utf8", 0, got);
      const lines = text.split("\n");
      text = lines.pop();
      for (const line of lines) {
        let d;
        try { d = JSON.parse(line); } catch { continue; }
        if (typeof d?.timestamp === "string") return Date.parse(d.timestamp);
      }
      if (at > 16 * 1024 * 1024) break;
    }
    try { const d = JSON.parse(text); if (typeof d?.timestamp === "string") return Date.parse(d.timestamp); } catch { /* torn tail */ }
    return null;
  } finally { fs.closeSync(fd); }
}

/** Per PR, the earliest start among its `review-pr-<n>` members' transcripts under `sessionsDir`. */
export function readReviewStarts(rows, sessionsDir, wanted) {
  const starts = new Map();
  for (const r of rows) {
    const pr = reviewPr(r);
    if (pr === null || !wanted.has(Number(pr))) continue;
    const t = firstTimestamp(path.join(sessionsDir, r.session, `${r.agent}.jsonl`));
    if (t === null || Number.isNaN(t)) continue;
    const prev = starts.get(Number(pr));
    if (prev === undefined || t < prev) starts.set(Number(pr), t);
  }
  return starts;
}

// --------------------------------------------------------------- output ----
const fmt = {
  "1": (v) => Math.round(v).toLocaleString("en-US"),
  "2": (v) => Math.round(v).toLocaleString("en-US"),
  "3a": (v) => `${(v / H).toFixed(2)} h`,
  "3b": (v) => `${v.toFixed(2)}/h`,
  "4a": (v) => `${(v / MIN).toFixed(1)} min`,
  "4b": (v) => `${(v / MIN).toFixed(1)} min`,
};
const show = (id, v) => (Number.isFinite(v) ? fmt[id](v) : "—");
const times = (x) => (Number.isFinite(x) ? `×${x.toFixed(2)}` : "—");
const row = (cells, widths) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd();

export function formatReport(r, meta) {
  const L = [];
  const P = (s = "") => L.push(s);
  P(`# In-flight guard — derived ${meta.derivedAt}`);
  P();
  P(`Repo \`${meta.repo}\`; ${meta.transport}; N = ${r.n}, offset = ${r.offset}. --merge ${r.merge}${r.cutover ? `, --cutover ${r.cutover}` : " (no --cutover: bands only)"}.`);
  P(`Query P: \`GET /${meta.query}&per_page=${PER_PAGE}&page=N\`, pages 1–${meta.pages} read (${meta.seen} closed PRs seen${meta.ended ? ", listing ended" : ""}${meta.listingReads ? `; read from GitHub ${meta.listingReads.first}${meta.listingReads.last !== meta.listingReads.first ? ` → ${meta.listingReads.last}` : ""}` : ""}).`);
  P();
  const h = r.history;
  P(`## History — merged PRs created in [${r.after}, ${r.merge}) (Query P)`);
  P();
  P(`${h.prs} merged PRs${h.range.numbers ? `, #${h.range.numbers[0]}–#${h.range.numbers[1]}, created ${h.range.created[0]} → ${h.range.created[1]}` : ""}; ${h.pairs} pairs of adjoining ${r.n}-PR windows, a pair every ${r.offset} PRs.`);
  P();
  P("## Band — post ÷ pre trips past it (the later ÷ the earlier window of each history pair)");
  P();
  const w = [4, 42, 5, 6, 10];
  P(row(["#", "signal", "pairs", "trips", "band"], w));
  for (const t of TESTS) {
    P(row([t.id, t.label, r.pairs[t.id], t.dir === "fall" ? "below" : "above", `${t.dir === "fall" ? "p10" : "p90"} ${times(r.bands[t.id])}`], w));
  }
  P();
  P(`Source per test — 3a, 3b: Query P. 1, 4a, 4b: \`${meta.memberOutcomes}\` (${meta.rowCount} rows), 4a/4b's start read from the member transcript under \`${meta.sessions}\`. 2: the \`/run-team\` session files under \`${meta.sessions}\` (${meta.sessionCount} session files read, ${meta.runTeamCount} of them \`/run-team\`, ${meta.badLines} unparseable transcript line(s) skipped).`);
  if (r.verdicts) {
    P();
    P("## Windows");
    P();
    for (const [name, win] of [["pre", r.pre], ["post", r.post]]) {
      P(`${name}: ${win.n} merged PRs${win.numbers ? `, #${win.numbers[0]}–#${win.numbers[1]}, created ${win.created[0]} → ${win.created[1]}` : ""}.`);
      const d = win.diag;
      P(`  signal 1: ${d.booked_rows} rows booked, ${d.unpriced_rows} unpriced, ${d.unbooked_prs.length} PRs unbooked${d.unbooked_prs.length ? ` (${d.unbooked_prs.map((x) => `#${x}`).join(" ")})` : ""}. signal 2: ${d.controller_turns} controller turns in the created span. signal 4: ${d.review_prs} PRs with a review start${d.no_review_prs.length ? `, ${d.no_review_prs.length} without (${d.no_review_prs.map((x) => `#${x}`).join(" ")}), excluded` : ""}.`);
    }
    P(`The post window spans ${r.post.run_team_sessions.length} \`/run-team\` session(s)${r.post.run_team_sessions.length ? `: ${r.post.run_team_sessions.join(", ")}` : ""}.`);
    P();
    P("## Verdicts — post ÷ pre against the band");
    P();
    const vw = [4, 42, 14, 14, 8, 10, 7];
    P(row(["#", "signal", "pre", "post", "ratio", "band", "verdict"], vw));
    for (const v of r.verdicts) P(row([v.id, v.label, show(v.id, v.pre), show(v.id, v.post), times(v.ratio), `${v.dir === "fall" ? "p10" : "p90"} ${times(v.band)}`, v.verdict === "none" ? "—" : v.verdict], vw));
    P();
    P(`tripped: ${r.tripped.length ? r.tripped.join(" ") : "none"}`);
    for (const id of r.tripped) P(`  Then (${id}): ${TESTS.find((t) => t.id === id).then}.`);
    if (r.tripped.length) P(`  ${NO_LICENCE}`);
  }
  if (r.no_verdict.length) {
    P();
    P("NO VERDICT:");
    for (const m of r.no_verdict) P(`  - ${m}`);
  }
  P();
  P(`exit ${r.exit}`);
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------ CLI ----
function main() {
  const die = makeDie(NAME);
  if (process.argv.slice(2).some((a) => a === "-h" || a === "--help")) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n")
      .filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
    return;
  }
  const { arg, numArg, has, sweep, stray } = defineFlags(die, {
    flags: {
      merge: "value", cutover: "value", after: "value", n: "value", offset: "value", repo: "value",
      cache: "value", refresh: "bool", transport: "value", "no-token": "bool",
      "member-outcomes": "value", sessions: "value", json: "value",
    },
  });
  sweep();
  stray();
  try {
    const mergeArg = arg("merge");
    if (mergeArg === null) die("--merge <ISO> is required: the mergedAt of the ticket that changes which PRs get Pulled");
    const merge = parseIso(mergeArg, "--merge");
    const cutoverArg = arg("cutover");
    const cutover = cutoverArg === null ? null : parseIso(cutoverArg, "--cutover");
    const after = parseIso(arg("after") ?? DEFAULTS.after, "--after");
    const n = numArg("n") ?? DEFAULTS.n, offset = numArg("offset") ?? DEFAULTS.offset;
    if (n < 1) die("--n must be a positive integer");
    if (offset < 1 || offset > n) die("--offset must be between 1 and --n");
    if (after >= merge) die("--after must be before --merge");
    const repo = arg("repo") ?? DEFAULTS.repo;
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) die(`--repo must be owner/name, got ${repo}`);
    const transportArg = arg("transport") ?? "auto";
    if (!["auto", "gh", "curl"].includes(transportArg)) die("--transport must be auto, gh or curl");

    const membersPath = arg("member-outcomes") ?? DEFAULTS.memberOutcomes;
    let rows;
    try { rows = parseMemberTsv(fs.readFileSync(membersPath, "utf8")); }
    catch (e) { die(`${membersPath}: ${e.code ?? e.message}`); }
    const sessionsArg = arg("sessions");
    const sessionsDir = sessionsArg ?? DEFAULTS.sessions;
    if (sessionsArg !== null && !fs.existsSync(sessionsDir)) die(`--sessions ${sessionsDir}: no such directory`);

    const gh = openGithubRead({
      repo, cache: arg("cache") ?? DEFAULT_CACHE, refresh: has("refresh"), transport: transportArg,
      noToken: has("no-token"), die, log: (msg) => process.stderr.write(`${msg}\n`),
    });
    const query = `repos/${repo}/pulls?state=closed&sort=created&direction=desc`;
    const { seen, pages, ended } = readPulls(gh.listPage, query, { after, merge, n });
    const prs = mergedPrs(seen);
    const reads = listingReads(gh.fetchedAt, query);
    const stale = staleWarning(reads, { now: Date.now(), cutover });
    if (stale !== null) process.stderr.write(`WARNING: ${stale}\n`);

    const haveSessions = fs.existsSync(sessionsDir);
    const sessions = haveSessions ? readSessions(sessionsDir) : [];
    const wanted = new Set(prs.map((p) => p.number));
    const reviewStarts = haveSessions ? readReviewStarts(rows, sessionsDir, wanted) : new Map();
    const report = analyze({ prs, merge, cutover, after, n, offset, rows, sessions, reviewStarts });
    const meta = {
      derivedAt: new Date().toISOString().slice(0, 16) + "Z", repo,
      transport: `${describeTransport(gh.transport)}; cache \`${gh.repoCacheDir}\``,
      query, pages, seen: seen.length, ended, listingReads: reads, memberOutcomes: membersPath, rowCount: rows.length,
      sessions: sessionsDir, sessionCount: sessions.length, runTeamCount: sessions.filter((s) => s.runTeam).length,
      badLines: sessions.reduce((sum, s) => sum + s.bad, 0),
    };
    process.stdout.write(formatReport(report, meta));
    const jsonPath = arg("json");
    if (jsonPath !== null) {
      fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...meta, report }, null, 2) + "\n");
      process.stderr.write(`json written to ${jsonPath}\n`);
    }
    process.exitCode = report.exit;
  } catch (e) {
    if (e instanceof InputError) die(e.message);
    throw e;
  }
}

if (isCLI(import.meta.url)) main();
