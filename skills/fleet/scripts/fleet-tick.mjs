#!/usr/bin/env node
// The reconcile tick. run-team's Phase 3 is an event loop, and implementer
// refill was wired as an EDGE — "a member finished → refill its slot". That
// edge dies the moment live implementers reach 0, because 0 implementers emit
// no completion event, and "free capacity + a non-empty pool" is a LEVEL
// condition an edge-triggered loop cannot observe once it stops changing. #3:
// implementers sat at 0/target with pool 1 and ~57 `ready-for-agent` in supply
// until a human asked why nothing was being implemented. No error, no warning.
//
// So compute the deficit instead of remembering it. One invocation prints
// actual/target and an explicit ACTION per role, with run-team's queue-depth
// guards applied in code rather than recalled from its table. You cannot forget
// what a script prints at you.
//
// WHERE THE NUMBERS COME FROM — the contract, and the one thing #3 left open:
//
//   args   Live member counts and the pool. The ledger records a DISPATCH
//          (`impl-332`), never a liveness: that token outlives the member's
//          death, its bail and the merge, and no field distinguishes them. A
//          liveness derived from it is a guess whose BOTH error directions are
//          the failures this script exists to prevent — over-count HOLDs, which
//          is the #3 stall itself, and under-count DISPATCHes past the cap. The
//          controller dispatched the members and receives their reports, so it
//          is the only component that knows; it states them. Required, never
//          defaulted, for the same reason: a default silently converts a
//          forgotten flag into one of those two failures.
//          Reviews in hand and merge holds arrive the same way and for the
//          same reason: `ready-to-merge` says a PR is signed off, never that
//          run-merge-bot's hold rule cleared it, and an open PR says a review
//          is owed, never that one has returned. Both are the controller's,
//          both are required, and neither defaults — a row that guesses them
//          prints an ACTION nobody can take, which is the #3 failure wearing
//          a number.
//   gh     Merge queue and review backlog, from open PRs by label and by
//          whether they close an issue.
//   script Supply, from candidates.mjs.
//
// The pure half below is `reconcile()`; main() does the I/O. Split so the guard
// table is unit-testable without a network — fleet-tick.test.mjs.

// Every role's TARGET is its configured cap. Availability of work belongs in
// the ACTION, not the target: a reviewer target that shrank to the backlog
// would print `0/0 → idle` and read as "correctly sized" for the exact drained
// state that is the defect.
export function reconcile(s) {
  return [implementers(s), reviewers(s), mergeBot(s)];
}

function implementers(s) {
  const deficit = s.implCap - s.implLive;
  const detail = `pool=${s.pool} supply=${s.supply} review-backlog=${s.reviewBacklog}`;
  const row = (action, extra = "") => ({
    role: "implementers", actual: s.implLive, target: s.implCap,
    action, detail: extra ? `${detail} — ${extra}` : detail,
  });

  if (deficit <= 0) return row("AT CAP");

  // The refill gate is the REVIEW backlog and never the merge-queue depth:
  // more PRs into a review-bound pipeline buys nothing, while a deep
  // ready-to-merge queue adds no rebases per PR and is not a reason to idle an
  // implementer. Checked before the pool table, and short-circuiting it: a
  // re-shortlist exists to enable a dispatch that is being held, and a /triage
  // suggestion under a hold is noise the controller would act on.
  if (s.reviewBacklog >= 2) return row("HOLD", "a review-bound pipeline gains nothing from more PRs");

  if (s.pool >= 1) return row(`DISPATCH ${Math.min(deficit, s.pool)}`);

  // Pool 0. Supply is open `ready-for-agent`, so it is an UPPER bound — the
  // decided? check and the in-flight scan both run downstream of it and only
  // ever remove tickets. An over-count therefore lands on `RE-SHORTLIST`
  // rather than `SUGGEST /triage`, and re-shortlisting is exactly what
  // discovers that the surplus was undecided. The safe direction.
  if (s.supply >= s.implCap) return row("RE-SHORTLIST", "ask the maintainer to tick");
  if (s.supply > 0) return row("RE-SHORTLIST + SUGGEST /triage");
  return row("SUGGEST /triage", "no supply — hold implementer slots idle");
}

function reviewers(s) {
  const deficit = s.reviewerCap - s.reviewerLive;
  const detail = `reviews-ready=${s.reviewsReady} review-backlog=${s.reviewBacklog}`;
  const row = (action, extra = "") => ({
    role: "reviewers", actual: s.reviewerLive, target: s.reviewerCap,
    action, detail: extra ? `${detail} — ${extra}` : detail,
  });
  if (deficit <= 0) return row("AT CAP");

  // The backlog is NOT this row's input. A reviewer slot holds a fix-applier
  // and a fix-applier applies findings, so a slot is dispatchable only once a
  // review has RETURNED — and on the default path the controller runs the
  // reviews itself, one at a time, so a deep backlog says only that reviews
  // are owed, never that anything can be handed out. It stays in the detail as
  // an observation; the ACTION comes off what the caller has in hand.
  if (s.reviewsReady >= 1) return row(`DISPATCH ${Math.min(deficit, s.reviewsReady)}`);

  // Nothing in hand. Idle only when nothing is owed either — a backlog with no
  // returned review is a pipeline waiting on the controller's own turn, which
  // is not a member this script can ask for.
  if (s.reviewBacklog === 0) return row("IDLE OK");
  return row("HOLD", "no review has returned — a fix-applier has nothing to apply yet");
}

function mergeBot(s) {
  // Cap is 1 by invariant, not by configuration.
  const detail = `merge-queue=${s.mergeQueue} held=${s.mergeHeld}`;
  const row = (action, extra = "") => ({
    role: "merge-bot", actual: s.mergeBotLive, target: 1,
    action, detail: extra ? `${detail} — ${extra}` : detail,
  });
  if (s.mergeBotLive >= 1) return row("AT CAP");
  if (s.mergeQueue === 0) return row("IDLE OK");

  // `ready-to-merge` is the author's sign-off and nothing more. run-merge-bot's
  // hold rule runs pr-overlap.mjs against every lower open PR and reports
  // `held-behind-#<lower>` without moving a label, so the label read above
  // cannot see it, and a bot dispatched against a queue whose candidates are
  // all held spends a whole member re-deriving a verdict already reported.
  // That is also exactly when a cascade is stalled and the line most likely to
  // be acted on without re-deriving.
  if (s.mergeQueue - s.mergeHeld <= 0) return row("HOLD", "every queued candidate is held behind a lower PR");
  return row("DISPATCH merge-bot");
}

export function formatLines(rows) {
  const w = Math.max(...rows.map((r) => r.role.length));
  return rows.map((r) => `${r.role.padEnd(w)} ${r.actual}/${r.target} → ${r.action}   (${r.detail})`);
}

// --------------------------------------------------------------------------
// I/O. Everything below runs only as a CLI — importing this file must never
// parse argv or touch the network, or the pure half stops being unit-testable.

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { makeDie } from "./arg.mjs";

const NAME = "fleet-tick";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Open PRs read per tick. At exactly this many the list may be truncated and
// nothing in the result says so, so it refuses — "no silent caps", same rule
// candidates.mjs enforces on its own query.
const PR_LIMIT = 200;

// die() shared with the other fleet scripts (writeSync-based, pipe-safe —
// see arg.mjs for the #176/#328/#363 rationale). This file parses its own
// options with node:util's parseArgs rather than arg()/has() — see OPTIONS
// below — so only die() is shared here.
const die = makeDie(NAME);

const OPTIONS = {
  implementers: { type: "string" },
  reviewers: { type: "string" },
  "merge-bots": { type: "string" },
  pool: { type: "string" },
  // Same contract as the live counts, for the same reason — see WHY below.
  "reviews-ready": { type: "string" },
  "merge-holds": { type: "string" },
  // Defaults here, not threaded through int(): declared this way they still
  // go through the guard below, where a hand-passed default went round it.
  "implementer-cap": { type: "string", default: "2" },
  "reviewer-cap": { type: "string", default: "5" },
};

// Why each caller-stated input has no default, quoted back at whoever forgot
// it. Every entry says the same thing about a different state: the controller
// holds it, the repo does not record it, and a guess fails in both directions.
const WHY = {
  live:
    "Live member counts and the pool are the CONTROLLER's state: " +
    "the ledger records a dispatch, never a liveness, so nothing in the repo can be read for them. " +
    "There is no safe default — 0 would dispatch a full cap off a forgotten flag, the cap would hold forever, " +
    "and both are silent.",
  "reviews-ready":
    "A reviewer slot holds a fix-applier, and a fix-applier applies findings — so this is the number of " +
    "reviews whose findings you HAVE with no fix-applier on them yet, not the number of PRs awaiting one. " +
    "On the default path you run each review yourself, one at a time, so a review still in flight is 0 here; " +
    "on the hand-dispatched fallback path it is the PRs a reviewer member can be given. Only you know it, " +
    "and either default is a failure: 0 holds the row forever, anything else dispatches members with " +
    "nothing to apply.",
  "merge-holds":
    "`ready-to-merge` is the author's sign-off, never a statement that the PR is dispatchable: " +
    "run-merge-bot's hold rule reads pr-overlap.mjs against every lower open PR and reports " +
    "`held-behind-#<lower>` without touching a label, so the queue read here is blind to it. " +
    "Pass the held PR numbers (`--merge-holds 601,604`, `#` optional) or the explicit `none`. " +
    "Defaulting to `none` prints DISPATCH merge-bot on every tick of a stalled cascade.",
};

function counts() {
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
    if (raw === undefined) die(`--${name} is required. ${WHY[name] ?? WHY.live}`);
    // Regex, not Number(): `Number("")` is 0 and `Number.isInteger(0)` is true,
    // so `--pool ""` — the shape an unset shell variable produces — would read
    // as a genuine, empty pool.
    if (!/^\d+$/.test(String(raw).trim())) die(`--${name} must be a non-negative integer, got '${raw}'`);
    return Number(raw);
  };
  const cap = (name) => {
    const n = int(name);
    // run-team's invariant, enforced where the number enters rather than where
    // it is used: <= 5 implementers, <= 5 reviewers, <= 1 merge bot.
    if (n < 1 || n > 5) die(`--${name} must be between 1 and 5 (run-team's member cap), got ${n}`);
    return n;
  };
  // PR numbers the last merge-bot pass reported held, or the explicit `none`.
  // The empty string is not that word on purpose: `--merge-holds ""` is the
  // shape an unset shell variable produces, and reading it as "nothing is held"
  // is precisely the silent default this flag exists to refuse.
  const holds = () => {
    const raw = values["merge-holds"];
    if (raw === undefined) die(`--merge-holds is required. ${WHY["merge-holds"]}`);
    const t = String(raw).trim();
    if (t === "none") return [];
    if (!/^#?\d+(\s*,\s*#?\d+)*$/.test(t)) {
      die(`--merge-holds must be 'none' or PR numbers like '601,604', got '${raw}'`);
    }
    return t.split(",").map((n) => Number(n.trim().replace("#", "")));
  };
  return {
    implLive: int("implementers"), reviewerLive: int("reviewers"), mergeBotLive: int("merge-bots"),
    pool: int("pool"), reviewsReady: int("reviews-ready"), mergeHolds: holds(),
    implCap: cap("implementer-cap"), reviewerCap: cap("reviewer-cap"),
  };
}

// Merge queue and review backlog from one read, with the caller's held set
// applied to the first. A failed read is not an empty pipeline: backlog 0 +
// merge-queue 0 is a plausible tick, so printing it off a failed query is the
// silent stall this script exists to end.
function prState(holds) {
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
  if (!Array.isArray(prs) || prs.some((p) => !p || typeof p.number !== "number"
    || !Array.isArray(p.labels) || !Array.isArray(p.closingIssuesReferences))) {
    die("gh pr list did not return {number,labels,closingIssuesReferences} rows");
  }
  if (prs.length === PR_LIMIT) {
    die(`exactly ${PR_LIMIT} open PRs — the list is capped and may be truncated. Raise PR_LIMIT; a backlog that silently drops PRs is not a reconcile.`);
  }
  const queued = prs.filter((p) => p.labels.some((l) => l && l.name === "ready-to-merge"));
  // A held number the queue does not contain is ignored, not refused: the
  // ordinary way a hold ends is the lower PR merging and the candidate merging
  // behind it, which leaves the caller quoting a number that has left the
  // queue, and a tick that refuses on the happy path is worse than one that
  // subtracts nothing.
  const mergeHeld = queued.filter((p) => holds.includes(p.number)).length;

  // Review backlog: open, not signed off, and REVIEW WORK. The third clause is
  // what the label read cannot express — a controller-authored chore PR is
  // left unlabelled for the maintainer and no member of the fleet will ever be
  // dispatched against it, so counting it floors the backlog at a number
  // nothing in the run can drain, and the implementer gate holds for the rest
  // of the run against a queue of nothing.
  //
  // GitHub's own linked-issue set decides that, not a keyword regex over the
  // body: docs/agents/issue-tracker.md records a body carrying `fixes #77`
  // inside a code span that GitHub did not link, so the regex over-reports.
  // The lazy recompute cuts the other way — a PR queried seconds after its
  // create can read as closing nothing — which drops it from the backlog for
  // one tick and can under-hold the implementer refill by one. Bounded, and
  // the next tick sees it; the permanent floor it replaces was not.
  //
  // ponytail: still the wider read on the other axis. A PR already reviewed,
  // ruled and merely waiting on CI counts here too, so the gate can hold the
  // refill EARLIER than run-team's own definition ("queued with no reviewer
  // slot") — never later. Narrowing that needs per-PR review state, which
  // lives in the controller's head and not in the repo. Upgrade path if the
  // over-count is measured to throttle implementers in practice: a
  // `--review-backlog <n>` override, on the same "the controller states what
  // only it knows" contract as the flags above.
  const reviewBacklog = prs.filter(
    (p) => !queued.includes(p) && p.closingIssuesReferences.length > 0,
  ).length;
  return { mergeQueue: queued.length, mergeHeld, reviewBacklog };
}

// Supply, from candidates.mjs — the same shortlist phase 0 uses, so the tick
// and the maintainer count the same queue.
function supply() {
  const r = spawnSync(process.execPath, [join(SCRIPT_DIR, "candidates.mjs"),
    "--require-label", "ready-for-agent"], { encoding: "utf8" });
  // stdio defaults to pipe, so candidates' per-candidate stderr — up to
  // --limit lines of it — is captured and dropped rather than billed to the
  // controller's context. Only the failure paths below say anything.
  if (r.error) die(`candidates.mjs did not run: ${r.error.code ?? r.error.message} — supply unknown`);
  // Exit 1 is candidates' documented "query fine, queue empty" AND Node's own
  // code for a module-not-found, a syntax error or any uncaught throw — the
  // collision candidates.mjs names on its own side. So the payload decides and
  // not the code: a genuinely empty queue is the only exit 1 printing `[]`.
  //
  // Exit 3 is that same zero supply arriving by the filter rather than the
  // query — the survivors existed and every one was a to-spec spec (#64) — so
  // it reports zero instead of refusing. The payload is checked on both: a
  // supply read whose stdout is not `[]` is not a supply of zero, whatever
  // code it carries.
  if ((r.status === 1 || r.status === 3) && r.stdout.trim() === "[]") return 0;
  // The signal too: a candidates.mjs killed by an OOM kill leaves status null,
  // and "exited null" names nothing. Same clause the gh read above already has.
  //
  // Tail of the child's own stderr appended, unlike the gh read above: that one
  // runs under execFileSync, which has already forwarded the child's stderr to
  // ours, so interpolating there emits every byte twice (#176). Here stdio is a
  // pipe and nothing else ever prints it, so candidates' own reason is lost and
  // the operator is left hunting a gh/auth failure for a queue that named its
  // cause. Bounded to the last few lines, which is not the same as suppressed:
  // a per-candidate line CAN ride along in that tail. What the bound buys is
  // that the ~--limit-line dump the pipe exists to keep out of the controller's
  // context cannot arrive whole, and only ever on the way to exit 2.
  if (r.status !== 0) {
    const why = (r.stderr ?? "").trim().split("\n").slice(-5).join("\n");
    die(`candidates.mjs ${r.signal ? `killed by ${r.signal}` : `exited ${r.status}`}`
      + ` — supply unknown, and unknown is not zero${why ? `\n${why}` : ""}`);
  }
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch (e) {
    die(`could not parse candidates.mjs output — supply unknown: ${e.message}`);
  }
  if (!Array.isArray(rows)) die("candidates.mjs did not return an array — supply unknown");
  return rows.length;
}

function main() {
  const { mergeHolds, ...c } = counts();
  // Both reads happen before anything prints: a partial tick is worse than no
  // tick, because half a reconcile still reads like a reconcile.
  const { mergeQueue, mergeHeld, reviewBacklog } = prState(mergeHolds);
  for (const line of formatLines(reconcile({ ...c, mergeQueue, mergeHeld, reviewBacklog, supply: supply() }))) {
    console.log(line);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
