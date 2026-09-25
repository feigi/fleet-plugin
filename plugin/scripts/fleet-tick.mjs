#!/usr/bin/env node
// The reconcile tick. run-team's Phase 3 is an event loop, and implementer
// refill was wired as an EDGE — "a member finished → refill its slot". That
// edge dies the moment live implementers reach 0, because 0 implementers emit
// no completion event, and "free capacity + a non-empty pool" is a LEVEL
// condition an edge-triggered loop cannot observe once it stops changing. #3:
// implementers sat at 0/target with pool 1 and ~57 `ready-for-agent` in supply
// until a human asked why nothing was being implemented. No error, no warning.
//
// So compute the deficit instead of remembering it. Every wake ends in one
// invocation (spec 2026-09-24 § 6: record, tick, act, beat), and each prints
// actual/target and a named ACTION per role — `PULL #412 #415`, `DISPATCH
// fix-pr PR#346`, `DISPATCH review PR#350`, `DISPATCH merge-bot`, `HOLD (…)`,
// `REFRESHED shortlist: …` — with run-team's guards applied in code rather than
// recalled from its table. You cannot forget what a script prints at you.
//
// WHERE THE NUMBERS COME FROM — nobody states them (#1803, ADR 0012 Decision 5):
//
//   ledger    `.fleet/ledger.md`, read through `ledger.mjs read` so the ledger
//             keeps one parser, and its member tokens through
//             ledger-grammar.mjs so it keeps one grammar. A member is live
//             while its token is bare (`impl-412`) and settled once it reads
//             `<member>=<outcome>` — `ledger.mjs dispatch` and `settle` are the
//             only writers of either, so the file answers "who is live" where
//             it once recorded only that someone was dispatched. Live
//             implementers, live reviewer units (in-flight `review=` plus
//             unsettled `fix-pr-`), the merge bot (`## Dispatched`), merge
//             holds (`held-behind:#M`), tier mismatches and the drain marker
//             all come off it. A missing ledger is a fresh run: zero rows.
//   shortlist `.fleet/shortlist.json`, shortlist.mjs's output, resolved against
//             the git common dir as ledger.mjs resolves the ledger. Its
//             entries minus every ticket with an `impl-` row, or an `excluded`
//             row whose premise still holds, are the heads a PULL names; its
//             `scanned` is the supply. Missing or unparsable is depth 0 and a
//             refresh, never a refusal: the depth only ever bounds PULLs
//             downward.
//   gh        The open PRs, by label and by whether they close an issue — the
//             merge queue, and which PRs are owed a review.
//
// The pure half below is `reconcile()` over the counts `deriveRun()` reads off
// the ledger; main() does the I/O. Split so the guard table and the reading are
// both unit-testable without a network — fleet-tick.test.mjs.

import { parseToken } from "./ledger-grammar.mjs";

// Every role's TARGET is its configured cap. Availability of work belongs in
// the ACTION, not the target: a reviewer target that shrank to the backlog
// would print `0/0 → idle` and read as "correctly sized" for the exact drained
// state that is the defect.
//
// The reviewer rows are computed first because the implementer row's gate
// reads what they leave: the slots this tick's own dispatches fill.
export function reconcile(s) {
  const rev = reviewers(s);
  return [implementers(s, rev.left), ...rev.rows, mergeBot(s), ...shortlistRows(s)];
}

// `acts` is on the row, set where the ACTION is chosen: the heartbeat backs off
// on "nothing to act on" and never on "output unchanged" (ADR 0008 §6), and the
// branch that picks the ACTION is the one place that knows which it is.
const mkRow = (role, actual, target, detail) => (action, { acts = false, extra = "" } = {}) => ({
  role, actual, target, action, acts, detail: extra ? `${detail} — ${extra}` : detail,
});

function implementers(s, left) {
  const row = mkRow("implementers", s.implLive, s.implCap,
    `unclaimed=${s.heads.length} supply=${s.supply ?? "?"} unreviewed=${left.unreviewed}`
    + (s.shortlistStatus === "ok" ? "" : ` shortlist=${s.shortlistStatus}`));

  // Drain stops supply and nothing else (spec § 6 §5). Read from the file, so
  // a replacement controller that never saw the drain is held by it too.
  if (s.draining !== null) return row("HOLD (draining)");
  // Held until a replacement at the right tier is dispatched (§ 6 §6). The
  // controller can fix this unattended, so the row asks it to.
  if (s.tierMismatch.length) return row(`HOLD (tier mismatch ${s.tierMismatch.join(" ")})`, { acts: true });

  const deficit = s.implCap - s.implLive;
  if (deficit <= 0) return row("AT CAP");

  // The review-backlog gate, NARROWED (§ 6 §4): more PRs into a review-bound
  // pipeline buy nothing — but the pipeline is review-bound only when a PR is
  // still owed its review after this tick's dispatches AND no reviewer slot is
  // left for it. A deep backlog with free slots is a reviewer-row DISPATCH on
  // this same tick, not a reason to idle an implementer; the old
  // `backlog >= 2` gate held there and starved implementers (#590's harm).
  // The merge queue never gates this row: a deep ready-to-merge queue adds no
  // rebases per PR.
  if (left.unreviewed >= 1 && left.free <= 0) return row("HOLD (review side saturated)");

  if (s.heads.length) return row(`PULL ${s.heads.slice(0, deficit).map((n) => `#${n}`).join(" ")}`, { acts: true });

  // Nothing unclaimed even after a refresh. `SUGGEST /triage` asks a
  // MAINTAINER to tick tickets, and on the unattended night the heartbeat
  // exists for there is nobody to ask — so it prints (the fold shows it once)
  // but is not actionable, or it would pin the interval at the base all night.
  return row("SUGGEST /triage, hold idle");
}

// Reviewer units (#1773 §3): an in-flight review = 1, each fix-applier = 1.
// Named in priority order — fix-appliers first, then reviews, oldest first —
// because finishing what is started beats starting more. Reviews are also
// bounded by `--max-reviews`: Claude runs at most one review Workflow at a time
// until two concurrent ones are measured, and the other slots still serve
// fix-appliers.
function reviewers(s) {
  const detail = `reviews=${s.reviewsLive} fix-pr=${s.fixLive} fix-due=${s.fixDue.length}`
    + ` review-due=${s.reviewDue.length} max-reviews=${s.maxReviews}`;
  const row = mkRow("reviewers", s.reviewsLive + s.fixLive, s.reviewerCap, detail);
  let free = Math.max(0, s.reviewerCap - s.reviewsLive - s.fixLive);
  const fixes = s.fixDue.slice(0, free);
  free -= fixes.length;
  const reviews = s.reviewDue.slice(0, Math.min(free, Math.max(0, s.maxReviews - s.reviewsLive)));
  free -= reviews.length;
  const prs = (ns) => ns.map((n) => `PR#${n}`).join(" ");

  const rows = [];
  if (fixes.length) rows.push(row(`DISPATCH fix-pr ${prs(fixes)}`, { acts: true }));
  if (reviews.length) rows.push(row(`DISPATCH review ${prs(reviews)}`, { acts: true }));
  if (!rows.length) {
    const owed = s.fixDue.length + s.reviewDue.length;
    if (owed && free <= 0) rows.push(row("AT CAP"));
    else if (s.reviewDue.length) rows.push(row(`HOLD (max-reviews ${s.maxReviews} in flight)`));
    else rows.push(row("IDLE OK"));
  }
  return { rows, left: { unreviewed: s.reviewDue.length - reviews.length, free } };
}

function mergeBot(s) {
  // Cap is 1 by invariant, not by configuration.
  const row = mkRow("merge-bot", s.mergeBotLive, 1, `merge-queue=${s.mergeQueue} held=${s.mergeHeld}`);
  if (s.mergeBotLive >= 1) return row("AT CAP");
  if (s.mergeQueue === 0) return row("IDLE OK");
  // `ready-to-merge` is the author's sign-off and nothing more. A bot
  // dispatched against a queue whose candidates are all held behind a lower
  // open PR spends a whole member re-deriving a verdict already recorded.
  if (s.mergeQueue - s.mergeHeld <= 0) return row("HOLD", { extra: "every queued candidate is held behind a lower PR" });
  return row("DISPATCH merge-bot", { acts: true });
}

// The refresh this tick ran, if it ran one. A REFRESHED that changed the list
// is actionable — supply arrived. One that changed nothing is not: every idle
// heartbeat tick refreshes while the shortlist is short of the cap, and an
// unconditionally actionable REFRESHED would pin the beat at its base interval
// on exactly the quiet night ADR 0008 backs off on. A failed refresh IS
// actionable: a blind implementer row backing off tick after identical tick is
// #3's stall exactly.
function shortlistRows(s) {
  const r = s.refresh;
  if (r === null) return [];
  if (!r.ok) return [{ role: "shortlist", action: "REFRESH FAILED", acts: true, detail: `${r.trigger} — ${r.why}` }];
  return [{
    role: "shortlist", action: `REFRESHED shortlist: ${r.entries} entries; ${r.lifted} lifted`, acts: r.changed,
    detail: r.changed ? r.trigger : `${r.trigger}; unchanged`,
  }];
}

export function formatLines(rows) {
  const w = Math.max(...rows.map((r) => r.role.length));
  return rows.map((r) => r.actual === undefined
    ? `${r.role.padEnd(w)} → ${r.action}   (${r.detail})`
    : `${r.role.padEnd(w)} ${r.actual}/${r.target} → ${r.action}   (${r.detail})`);
}

// Does this tick ask the controller for anything? Identity decides whether to
// FOLD the output; only this decides whether to back off (ADR 0008 §6). A tick
// printing `PULL #412` every five minutes because the controller has not acted
// is byte-identical each time, and backing off there would stretch the
// interval while work sat unclaimed.
export function actionable(rows) {
  return rows.some((r) => r.acts);
}

// --------------------------------------------------------------------------
// Reading the run. Pure: `ledger.mjs read`'s payload and the open-PR list in,
// counts out. Throws LedgerError on a token it cannot read — a member counted
// live or gone on a guess is the over- or under-dispatch this file exists to
// prevent, so the tick refuses instead.

export class LedgerError extends Error {}

// A row's PR is its first `PR#<n>` mention — ledger.mjs rowPr()'s reading, so
// both the `→ PR#346` arrow and a settled `impl-324=PR#346` name it. A row
// with none is keyed by the PR's own number when it is about a PR at all (a PR
// this run's implementers did not open), the fallback ledger.mjs's
// memberRowIndex() takes. Ticket and PR numbers share GitHub's one number
// space, so a ticket's key never names an open PR.
const PR_MENTION = /\bPR\s*#(\d+)\b/;
// shortlist.mjs's own spelling of an Exclusion row and its premises.
const EXCLUDED_ROW = /^#[0-9]+[ \t]+excluded(?=[ \t]|$)([\s\S]*)$/;
const PREMISE = /\bbehind-(pr|issue):#?([^\s,;]+)/g;
// #1773 §7: `review=wf:<runId>` | `review=member:review-pr-<n>` |
// `review=fallback:review-pr-<n>[-b]`, settled dead as `…=failed`; the result
// is `reviewed=<head>:<survived>/<refuted>/<unverified>`.
const REVIEW = /^review=(?:wf|member|fallback):[^=\s]+(=failed)?$/;
const REVIEWED = /^reviewed=[0-9a-f]{7,40}:(\d+)\/(\d+)\/(\d+)$/i;
const HELD = /^held-behind[:-]#?(\d+)$/;

export function deriveRun({ rows, dispatched, drain }, prs) {
  // One entry per member name across `## Dispatched` and every row. A member
  // settled ANYWHERE is settled: `settle` is the only writer of an outcome, and
  // a bare copy beside it is what a whole-line `row` rewrite leaves behind.
  const members = new Map();
  const note = (t, where) => {
    if (t.error) throw new LedgerError(`${where}: ${t.name}: ${t.error}`);
    const m = members.get(t.name) ?? { name: t.name, family: t.family, number: t.number, outcome: null };
    if (t.outcome !== null) m.outcome = t.outcome;
    members.set(t.name, m);
  };
  for (const e of dispatched) {
    const t = parseToken(e);
    if (!t) throw new LedgerError(`## Dispatched entry '${e}' is not a member token — fix the ledger by hand before the tick can count from it`);
    note(t, `## Dispatched entry '${e}'`);
  }

  const open = new Set(prs.map((p) => p.number));
  const claimed = new Set();
  const excluded = [];
  const byPr = new Map();
  for (const text of rows) {
    const key = text.split(/\s/)[0];
    const keyNum = /^#[0-9]+$/.test(key) ? Number(key.slice(1)) : null;
    const where = `row '${text}'`;
    const st = { inFlight: false, reviewed: false, reviewedAny: false, survived: 0, fixSince: false, held: [] };
    for (const tok of text.split(/\s+/).filter(Boolean)) {
      const t = parseToken(tok);
      if (t) {
        note(t, where);
        // A settled `failed`/`killed` fix-applier leaves survivors unfixed and
        // no successor dispatched — the PR stays fix-due for a `-b`
        // replacement. Only a live attempt, or one that actually landed
        // (`applied:`/`no-op`), clears it.
        if (t.family === "fix-pr" && (t.outcome === null || t.outcome === "no-op" || /^applied:/.test(t.outcome))) st.fixSince = true;
        continue;
      }
      if (tok.startsWith("review=")) {
        const m = REVIEW.exec(tok);
        if (!m) throw new LedgerError(`${where}: '${tok}' is not review=wf:<runId> | member:review-pr-<n> | fallback:review-pr-<n>, optionally =failed`);
        st.inFlight = !m[1];
        if (!m[1]) st.reviewedAny = true;
      } else if (tok.startsWith("reviewed=")) {
        const m = REVIEWED.exec(tok);
        if (!m) throw new LedgerError(`${where}: '${tok}' is not reviewed=<head>:<survived>/<refuted>/<unverified>`);
        Object.assign(st, { inFlight: false, reviewed: true, reviewedAny: true, survived: Number(m[1]), fixSince: false });
      } else {
        const h = HELD.exec(tok);
        if (h) st.held.push(Number(h[1]));
      }
    }
    const ex = EXCLUDED_ROW.exec(text);
    if (ex && keyNum !== null) {
      const premises = [...ex[1].matchAll(PREMISE)].map(([, kind, target]) => ({ kind, target }));
      // ADR 0013 §48: an `excluded` row claims its ticket only while its
      // premise still holds. Lifted here only when EVERY premise is a
      // verifiable, now-closed `behind-pr:#M` — the same rule a
      // `held-behind` merge hold uses — since a mixed or `behind-issue`
      // premise needs a live gh probe this pure half cannot make;
      // unclaimed() covers that case once the refreshed shortlist re-admits
      // the ticket.
      const prLifted = premises.length > 0
        && premises.every(({ kind, target }) => kind === "pr" && /^\d+$/.test(target) && !open.has(Number(target)));
      if (!prLifted) claimed.add(keyNum);
      excluded.push({ n: keyNum, premises });
    }
    const m = PR_MENTION.exec(text);
    const pr = m ? Number(m[1]) : keyNum;
    if (pr !== null && !byPr.has(pr)) byPr.set(pr, st);
  }

  const all = [...members.values()];
  const live = (family) => all.filter((m) => m.family === family && m.outcome === null).length;
  const impls = all.filter((m) => m.family === "impl");
  for (const m of impls) claimed.add(m.number);
  // A mismatch is fixed by dispatching a replacement (`impl-N-b`) at the right
  // tier; until the LATEST member for that ticket settles at a different
  // outcome, the row holds — a replacement that is ALSO tier-mismatch keeps
  // holding, it does not clear the row.
  const tierMismatch = impls
    .filter((m, i) => m.outcome === "tier-mismatch" && !impls.some((o, j) => j > i && o.number === m.number))
    .map((m) => m.name);
  const isQueued = (p) => p.labels.some((l) => l && l.name === "ready-to-merge");
  const queued = prs.filter(isQueued);
  const asc = (a, b) => a - b;
  const state = (n) => byPr.get(n);
  return {
    implLive: live("impl"),
    fixLive: live("fix-pr"),
    mergeBotLive: live("merge-bot"),
    reviewsLive: [...byPr.values()].filter((st) => st.inFlight).length,
    // A returned review with survivors and no fix-applier since it returned,
    // on a PR still open, with no newer review running.
    fixDue: [...byPr.entries()]
      .filter(([n, st]) => open.has(n) && st.reviewed && st.survived > 0 && !st.fixSince && !st.inFlight)
      .map(([n]) => n).sort(asc),
    // Open, not signed off, closing an issue (GitHub's own linked set — a
    // chore PR closing nothing is review work nobody in the run will ever be
    // dispatched against, #590), with no live or returned review on record.
    reviewDue: prs
      .filter((p) => !isQueued(p) && p.closingIssuesReferences.length > 0 && !state(p.number)?.reviewedAny)
      .map((p) => p.number).sort(asc),
    mergeQueue: queued.length,
    // A hold lifts once its premise PR has left the open list — MERGED or
    // CLOSED, the same lift rule as a `behind-pr` Exclusion.
    mergeHeld: queued.filter((p) => (state(p.number)?.held ?? []).some((m) => open.has(m))).length,
    draining: drain ?? null,
    tierMismatch,
    claimed,
    excluded,
  };
}

// The shortlist entries no `impl-` or `excluded` row has claimed, in the
// file's own oldest-first order. A `behind-pr:#M` exclusion is trusted from
// `run.claimed` alone — `open` is read fresh every tick, so there is nothing
// stale to defer to. An exclusion deriveRun cannot verify purely (a
// `behind-issue` or branch-named premise) is different: its row is rewritten
// only when a Pull dispatches the ticket (shortlist.mjs's own header, §3),
// never on its own, so once shortlist.mjs's live probe has re-admitted the
// ticket to these entries, that stale row no longer blocks it.
export function unclaimed(entries, run) {
  const unverifiable = new Set(run.excluded
    .filter((e) => e.premises.every(({ kind, target }) => kind !== "pr" || !/^\d+$/.test(target)))
    .map((e) => e.n));
  return entries.map((e) => e.n).filter((n) => !run.claimed.has(n) || unverifiable.has(n));
}

// shortlist.mjs's payload, `{scanned, shortlist: [{n, t}]}`, or unparsable.
export function parseShortlist(text) {
  const none = { status: "unparsable", scanned: null, entries: [] };
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return none;
  }
  if (!d || typeof d !== "object" || !Number.isInteger(d.scanned) || d.scanned < 0 || !Array.isArray(d.shortlist)
    || !d.shortlist.every((e) => e && Number.isInteger(e.n) && e.n > 0 && typeof e.t === "string")) return none;
  return { status: "ok", scanned: d.scanned, entries: d.shortlist.map(({ n, t }) => ({ n, t })) };
}

// Why this tick refreshes the shortlist, or null (§ 6 §3). The premise-lifted
// trigger costs gh calls, so main() asks it only when these answer null.
export function refreshWhy({ draining, status, entries, unclaimed: k, implCap }) {
  if (draining !== null) return null;
  if (status !== "ok") return `shortlist ${status}`;
  if (entries === 0) return "shortlist empty";
  if (k < implCap) return `unclaimed ${k} < cap ${implCap}`;
  return null;
}

// --------------------------------------------------------------------------
// I/O. Everything below runs only as a CLI — importing this file must never
// parse argv or touch the network, or the pure half stops being unit-testable.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { makeDie, isDigits } from "./arg.mjs";
import { gitEnv, workspaceDirFromGitCommonDir } from "./git-env.mjs";
import { statePath, readState, writeState, assessBeat, isStalled, stallReport } from "./fleet-state.mjs";

const NAME = "fleet-tick";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Open PRs read per tick. At exactly this many the list may be truncated and
// nothing in the result says so, so it refuses — "no silent caps", same rule
// candidates.mjs enforces on its own query.
const PR_LIMIT = 200;
// Claimed tickets read per stall report. Same "no silent caps" rule as
// PR_LIMIT above, resolved the other way: the read below cannot REFUSE at the
// cap, because refusing would suppress the one announcement a dead run leaves
// behind. So it discloses instead — the line says the count is a floor.
const CLAIMED_LIMIT = 200;
const MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

// die() shared with the other fleet scripts (writeSync-based, pipe-safe —
// see arg.mjs for the #176/#328/#363 rationale). This file parses its own
// options with node:util's parseArgs rather than arg()/has(), so die() and
// the isDigits() rule int() calls are all it shares.
const die = makeDie(NAME);

// Every input the controller used to state is read off the run now, so what
// is left is configuration, and all of it defaults.
const OPTIONS = {
  // Defaults here, not threaded through int(): declared this way they still
  // go through the guard below, where a hand-passed default went round it.
  // 2/6 (#1773): no hard cap on either role, defaults only.
  "implementer-cap": { type: "string", default: "2" },
  "reviewer-cap": { type: "string", default: "6" },
  // Reviews in flight at once. Default = the reviewer cap; the Claude side
  // passes `--max-reviews 1` until two concurrent Workflows are measured.
  "max-reviews": { type: "string" },
  // `--fold-unchanged` prints ONE line instead of the rows when this tick asks
  // for nothing and says exactly what the last one said — what makes an
  // unattended night affordable. Opt-in because folding is wrong on an edge:
  // a controller that just acted needs the full rows.
  "fold-unchanged": { type: "boolean", default: false },
  // Path override, for tests. An empty value cannot be told from an absent one
  // under parseArgs, and no path is legitimately empty, so empty resolves to
  // the default.
  state: { type: "string", default: "" },
};

function options() {
  let values;
  try {
    ({ values } = parseArgs({ options: OPTIONS }));
  } catch (e) {
    // Unconditional catch, deliberately — parseArgs throws on the FIRST
    // offending argument, so dropping any error code disables the guard for
    // every argv where something else comes earlier.
    die(`${e.message} — accepted: ${Object.keys(OPTIONS).map((f) => `--${f}`).join(", ")}`);
  }
  const int = (name) => {
    const raw = values[name];
    // #878: the digits rule, called rather than restated. Digits, not
    // Number(): `Number("")` is 0, so `--max-reviews ""` — the shape an unset
    // shell variable produces — would otherwise read as a real number.
    if (!isDigits(String(raw).trim())) die(`--${name} must be a non-negative integer, got '${raw}'`);
    return Number(raw);
  };
  const positive = (name) => {
    const n = int(name);
    if (n < 1) die(`--${name} must be at least 1, got ${n}`);
    return n;
  };
  const reviewerCap = positive("reviewer-cap");
  return {
    implCap: positive("implementer-cap"), reviewerCap,
    maxReviews: values["max-reviews"] === undefined ? reviewerCap : positive("max-reviews"),
    fold: values["fold-unchanged"], state: values.state || statePath(NAME),
  };
}

// The open PRs, validated. A failed read is not an empty pipeline: backlog 0 +
// merge-queue 0 is a plausible tick, so printing it off a failed query is the
// silent stall this script exists to end.
function openPrs() {
  let out;
  try {
    out = execFileSync("gh", ["pr", "list", "--state", "open", "--limit", String(PR_LIMIT),
      "--json", "number,labels,closingIssuesReferences"], { encoding: "utf8" });
  } catch (e) {
    // Never interpolates e.stderr or e.message: execFileSync already forwarded
    // the child's stderr to ours, and Node builds e.message out of it, so
    // either one emits every byte a second time (#176).
    die(`gh pr list failed: ${e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)} — a failed read is not an empty queue`);
  }
  let prs;
  try {
    prs = JSON.parse(out);
  } catch (e) {
    die(`could not parse gh pr list output as JSON: ${e.message}`);
  }
  // closingIssuesReferences is checked, not defaulted: absent, it would read as
  // an empty list and drop every open PR from review work.
  if (!Array.isArray(prs) || prs.some((p) => !p || typeof p.number !== "number"
    || !Array.isArray(p.labels) || !Array.isArray(p.closingIssuesReferences))) {
    die("gh pr list did not return {number,labels,closingIssuesReferences} rows");
  }
  if (prs.length === PR_LIMIT) {
    die(`exactly ${PR_LIMIT} open PRs — the list is capped and may be truncated. Raise PR_LIMIT; a backlog that silently drops PRs is not a reconcile.`);
  }
  return prs;
}

// A child that did not exit 0, named with the last line it printed.
function failure(r, what) {
  if (r.error) return `${what} did not run: ${r.error.code ?? r.error.message}`;
  const last = String(r.stderr ?? "").trim().split("\n").at(-1);
  return `${what} ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}${last ? `: ${last}` : ""}`;
}

// Through `ledger.mjs read`, never parsed here, so the ledger keeps one parser
// — shortlist.mjs's rule. Its stderr passes straight through: its WARNING on an
// unresolved workspace is the operator's to see. A read that fails refuses the
// tick: counting a run nobody could read is the guess this file replaced.
function readLedger() {
  const r = spawnSync(process.execPath, [join(SCRIPT_DIR, "ledger.mjs"), "read"], {
    encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "inherit"],
  });
  if (r.error || r.status !== 0) die(`${failure(r, "ledger.mjs read")} — the run cannot be counted from a ledger nobody could read`);
  let d;
  try {
    d = JSON.parse(r.stdout);
  } catch (e) {
    die(`could not parse ledger.mjs read output: ${e.message}`);
  }
  const strings = (xs) => Array.isArray(xs) && xs.every((x) => typeof x === "string");
  if (!d || !strings(d.rows) || !strings(d.dispatched) || !(d.drain === null || typeof d.drain === "string")) {
    die("ledger.mjs read returned no {rows, dispatched, drain}");
  }
  return d;
}

// `.fleet/shortlist.json` beside the run's ledger: the workspace from `git
// rev-parse --git-common-dir`, GIT_DIR/GIT_WORK_TREE scrubbed (#1599) so an
// ambient one cannot answer for another repository. null when unresolvable —
// read as a missing shortlist, and the refresh then says why it could not run.
function shortlistPath() {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, env: gitEnv() });
  const workspace = workspaceDirFromGitCommonDir(r.stdout);
  return workspace === null ? null : join(workspace, ".fleet", "shortlist.json");
}

function readShortlist(path) {
  if (path === null) return { status: "missing", scanned: null, entries: [] };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { status: "missing", scanned: null, entries: [] };
    // Distinct from `unparsable`: that label's only other producer is
    // genuinely malformed JSON, and a permissions/filesystem fault reported
    // as a JSON-content fault sends the operator chasing the wrong repair.
    return { status: "unreadable", scanned: null, entries: [], code: e.code ?? null, message: e.message };
  }
  return parseShortlist(text);
}

// An Exclusion whose premise has lifted, for a ticket the current file does
// not already carry (if it does, the refresh that lifted it has run). A
// `behind-pr:#M` reads off the open list already in hand; a `behind-issue:#M`
// costs one `gh issue view`. A branch-named `behind-pr` is left to the
// refresh itself: before its PR exists, "no open PR" is not "merged". Any
// probe that cannot answer leaves the exclusion standing.
function liftedPremise(excluded, entries, prs) {
  const inFile = new Set(entries.map((e) => e.n));
  const open = new Set(prs.map((p) => p.number));
  for (const { n, premises } of excluded) {
    if (inFile.has(n)) continue;
    for (const { kind, target } of premises) {
      if (!isDigits(target)) continue;
      if (kind === "pr" && !open.has(Number(target))) return `behind-pr:#${target} no longer open`;
      if (kind === "issue") {
        // Scrubbed as shortlist.mjs's probeState() is: gh's remote resolution
        // follows GIT_DIR/GIT_WORK_TREE, and GH_REPO outranks both.
        const r = spawnSync("gh", ["issue", "view", target, "--json", "state"], { encoding: "utf8", env: gitEnv({ GH_REPO: "" }) });
        if (r.error || r.status !== 0) {
          // Disclosed, not dropped: every other gh call in this file either
          // dies or logs its failure — a bare empty catch here would be the
          // one silent exception in a file whose whole design goal is "no
          // silent stall".
          console.error(`${NAME}: ${failure(r, `gh issue view ${target}`)} — behind-issue:#${target} premise unconfirmed, exclusion stands`);
          continue;
        }
        let st = null;
        try { st = JSON.parse(r.stdout).state; } catch { /* unanswered: the exclusion stands */ }
        if (st === "CLOSED" || st === "MERGED") return `behind-issue:#${target} ${st}`;
      }
    }
  }
  return null;
}

// shortlist.mjs, run by the tick itself (§ 6 §3). Its per-ticket stderr is
// captured and dropped rather than billed to the controller's context; only a
// failure's last line rides along.
function refresh() {
  const r = spawnSync(process.execPath, [join(SCRIPT_DIR, "shortlist.mjs")], {
    encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0) return { ok: false, why: failure(r, "shortlist.mjs") };
  const p = parseShortlist(r.stdout);
  if (p.status !== "ok") return { ok: false, why: "shortlist.mjs printed no {scanned, shortlist}" };
  return { ok: true, ...p };
}

// How many tickets a dead run stranded. `in-progress` is the claim label
// claim-ticket.sh adds and candidates.mjs's query EXCLUDES — which is why a
// stranded ticket is invisible to the next run's scans, and why this count is
// the actionable half of the report. null for unknown, never 0: a failed query
// reporting "0 claimed" says the dead run stranded nothing.
function claimed() {
  const r = spawnSync("gh", ["issue", "list", "--label", "in-progress", "--state", "open",
    "--limit", String(CLAIMED_LIMIT), "--json", "number", "--jq", "length"], { encoding: "utf8" });
  if (r.error || r.status !== 0) {
    // Disclosed, not dropped: a real gh failure must be distinguishable from
    // the deliberately-undiagnosed case.
    const why = r.error
      ? `gh did not run: ${r.error.code ?? r.error.message}`
      : `gh ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}`;
    const tail = (r.stderr ?? "").trim().split("\n").slice(-5).join("\n");
    console.error(`${NAME}: ${why} — claimed ticket count unknown${tail ? `\n${tail}` : ""}`);
    return null;
  }
  const n = Number(r.stdout.trim());
  if (!Number.isInteger(n) || n < 0) return null;
  // At exactly the cap the list may be truncated, so the report says so.
  return n === CLAIMED_LIMIT ? `${n}+` : n;
}

function main() {
  const { fold, state: path, ...caps } = options();
  const current = readShortlist(shortlistPath());

  // The PRIOR run's liveness, before anything that can refuse — #1597. The gh
  // read and the ledger read below both exit 2 on failure, and a stall
  // announced after them is a stall a gh outage can silence. The supply it
  // reports is the local shortlist file's, which no outage can take away.
  const priorState = readState(path, NAME);
  const verdict = assessBeat({ beat: priorState.beat, ticked: priorState.ticked, now: Date.now() });
  if (isStalled(verdict)) console.log(stallReport(verdict, { claimed: claimed(), supply: current.scanned }));

  // Every read happens before anything prints: a partial tick is worse than no
  // tick, because half a reconcile still reads like a reconcile.
  const prs = openPrs();
  let run;
  try {
    run = deriveRun(readLedger(), prs);
  } catch (e) {
    if (e instanceof LedgerError) die(e.message);
    throw e;
  }

  // Pull from the current file first; refresh when it is short, absent, or an
  // exclusion has lifted — and top the PULL up from what the refresh found,
  // so a slot the current file could not fill does not wait a tick for it.
  let heads = unclaimed(current.entries, run);
  let supply = current.scanned;
  let fresh = null;
  const trigger = refreshWhy({ draining: run.draining, status: current.status, entries: current.entries.length,
    unclaimed: heads.length, implCap: caps.implCap })
    ?? (run.draining === null ? liftedPremise(run.excluded, current.entries, prs) : null);
  if (trigger) {
    const r = refresh();
    if (r.ok) {
      const excludedSet = new Set(run.excluded.map((x) => x.n));
      heads = [...new Set([...heads, ...unclaimed(r.entries, run)])];
      supply = r.scanned;
      fresh = {
        ok: true, trigger, entries: r.entries.length,
        lifted: r.entries.filter((e) => excludedSet.has(e.n)).length,
        changed: r.entries.map((e) => e.n).join(",") !== current.entries.map((e) => e.n).join(","),
      };
    } else {
      fresh = { ok: false, trigger, why: r.why };
    }
  }

  const rows = reconcile({
    ...caps, ...run, heads, supply, shortlistStatus: current.status, refresh: fresh,
  });
  const lines = formatLines(rows);

  // The back-off streak and the fold digest, written on EVERY tick: an edge
  // tick that dispatched is the clearest possible "there is work here". Digest,
  // not the lines themselves, so the file stays readable. Re-read rather than
  // reusing priorState: this must be the freshest snapshot, or this tick
  // reverts whatever the heartbeat wrote while the reads above were in flight.
  const prev = readState(path, NAME);
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  const acts = actionable(rows);
  // `ticked`, fleet-tick's own liveness key (#1597 follow-up): written on
  // every invocation unconditionally — this tick running IS the occurrence.
  writeState(path, NAME, prev, { quiet: acts ? 0 : prev.quiet + 1, digest, ticked: { at: Date.now() } });

  // Fold only when BOTH hold: nothing to act on, and nothing new to say.
  if (fold && !acts && digest === prev.digest) {
    console.log(`fleet-tick: unchanged, nothing to act on (quiet=${prev.quiet + 1}) — full rows on the next change`);
    return;
  }
  for (const line of lines) console.log(line);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
