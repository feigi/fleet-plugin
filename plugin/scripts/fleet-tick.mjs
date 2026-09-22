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
//   pool   OPTIONALLY, and for the implementer row only: a dispatch pool's own
//          status, in place of the two numbers above. Same contract read the
//          other way round — where the ledger cannot be read for a liveness,
//          the pool that holds the members CAN be, so the controller stops
//          reciting what the runtime already knows. It does not weaken the
//          refusal above, it extends it: a pool that did not answer is
//          UNKNOWN, never 0, because the zero it would otherwise read as is a
//          full cap's worth of free capacity. Every row says which of the two
//          sources its counts came from (#1587).
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

// Where a row's counts came from, as a value ON the row.
//
// The two sources can legitimately DISAGREE: a member the controller dispatched
// outside the pool is live and invisible to the pool's own status, so "1 live"
// from the pool and "2 live" from the controller can both be honest readings of
// the same fleet. A row that prints an ACTION without saying which number
// produced it is untraceable, and untraceable is how #3 stayed invisible for a
// whole run.
const STATED = "caller-stated";
const POOL = "pool-derived";
// Not a third source — the one value that means there are no counts, so
// nothing downstream can mistake a refusal for a reading.
const UNKNOWN = "unknown";

// Both refusals end with this, because both fail in the same direction. An
// absent reading and a garbled one would each present as 0 live with a full cap
// free — a pool that never opened, closed on its drain, or went with its kernel
// reading as a full cap's worth of free capacity — which is a DISPATCH of the
// whole cap at a pool nobody read. That is the over-dispatch direction the
// caller-stated flags' own refusal exists to block, and a pool that swapped a
// forgotten flag for a lost kernel would have moved that failure, not fixed it.
//
// The printed half is the instruction only. The paragraph above is why, and a
// row that lectures is a row read past: what the operator needs at 3am is the
// missing input named, and the two ways out.
const NOT_ZERO = " Unknown is not zero live: re-open the pool and re-run, or fall back to the"
  + " caller-stated counts.";

// The implementer row's liveness inputs, and their provenance.
//
// `poolLiveness` is optional, and its PRESENCE — never its truthiness — picks
// the source. Key absent: the caller states the counts, which is today's path
// and the only shape the hand-dispatch harness uses. Key present: the pool is
// this row's source, and any stated counts are at most a cross-check printed
// back beside the ACTION.
//
// So present-but-empty is a REFUSAL and never a quiet fall back to the stated
// flags. Falling back is the tempting half — the numbers are right there, and
// using them looks like resilience. It is the #3 failure with a helpful face:
// those numbers are the controller's recollection, which is the exact thing
// adopting a pool stops trusting, and the swap would leave a run whose
// dispatches came from a source no line names.
//
// The shape is the fleet's own (`live`, `queued`), not any runtime's status
// field names: the caller maps at the boundary, which is what keeps pool
// internals out of this file and out of its tests.
function liveness(s) {
  if (!("poolLiveness" in s)) return { provenance: STATED, live: s.implLive, queued: s.pool };
  const p = s.poolLiveness;
  if (p === null || p === undefined) {
    return { provenance: UNKNOWN, why: "pool status absent: nothing answered for live and queued." };
  }
  // Both counts checked, and every bad one named back. `Number.isInteger` and
  // not `typeof === "number"`: NaN is a number, `cap - NaN` is NaN, and every
  // comparison against NaN is false — so a reading that never arrived would
  // slide past the deficit test and print AT CAP, which is #3's stall exactly.
  // `p?.[k]` because a status that is not an object at all (a bare number, a
  // string) is unreadable in the same way and by the same clause.
  const show = (v) => (typeof v === "string" ? `'${v}'` : String(v));
  const bad = ["live", "queued"].filter((k) => !Number.isInteger(p?.[k]) || p[k] < 0);
  if (bad.length) {
    return {
      provenance: UNKNOWN,
      why: `pool status unreadable: ${bad.map((k) => `${k}=${show(p?.[k])}`).join(", ")}`
        + " — live and queued must each be a non-negative integer.",
    };
  }
  return { provenance: POOL, live: p.live, queued: p.queued };
}

function implementers(s) {
  const l = liveness(s);
  // The marker prints only when the counts did NOT come from the caller. Not a
  // silent default: the stated path is what every line this script has ever
  // printed already means, and those bytes are also what the fold digest
  // hashes, so marking them would change every tick's output to say what it
  // already said. What a reader needs is to tell an UNMARKED line — the
  // contract they know — from one whose numbers came from somewhere else. The
  // row states it either way, for a consumer that branches on the field.
  const from = l.provenance === STATED ? "" : ` counts=${l.provenance}`;

  if (l.provenance === UNKNOWN) {
    return {
      role: "implementers",
      // `?`, never a number. A consumer that reads past the ACTION and does
      // arithmetic gets NaN rather than a plausible count, so the one reading
      // this row must never produce — a full cap's worth of free capacity — is
      // not reachable even by ignoring everything the row says.
      actual: "?", target: s.implCap, provenance: UNKNOWN, action: "REFUSE",
      detail: `pool=? supply=${s.supply} review-backlog=${s.reviewBacklog}${from} — ${l.why}${NOT_ZERO}`,
    };
  }

  const deficit = s.implCap - l.live;
  // The caller's own numbers, when it stated them anyway and the pool
  // disagrees. Printed back rather than dropped: the disagreement is
  // legitimate — a member dispatched outside the pool is live and invisible to
  // it — so the row that acted on one number names the other it did not use.
  // Silent on agreement, because a second copy of the same figures would bury
  // the one case this clause exists to make visible.
  const unused = [["live", s.implLive, l.live], ["pool", s.pool, l.queued]]
    .filter(([, stated, used]) => stated !== undefined && stated !== used)
    .map(([name, stated]) => `${name}:${stated}`);
  const detail = `pool=${l.queued} supply=${s.supply} review-backlog=${s.reviewBacklog}${from}`
    + (unused.length ? ` stated-unused=${unused.join(",")}` : "");
  const row = (action, extra = "") => ({
    role: "implementers", actual: l.live, target: s.implCap, provenance: l.provenance,
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

  if (l.queued >= 1) return row(`DISPATCH ${Math.min(deficit, l.queued)}`);

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
  // Always caller-stated, and the row says so rather than leaving a reader to
  // infer it from a field that is missing: no pool stages reviewers, so this
  // row has exactly one source and no disagreement to report. Nothing extra is
  // printed — the line is byte-for-byte the one it has always been.
  const row = (action, extra = "") => ({
    role: "reviewers", actual: s.reviewerLive, target: s.reviewerCap, provenance: STATED,
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
  //
  // `ignored=` names the held numbers the queue does not contain. Accepting
  // them is deliberate (see prState), but an unnamed rejection makes a typo,
  // or the ISSUE number passed where the PR number belongs, produce output
  // byte-identical to `--merge-holds none` — the exact DISPATCH the flag was
  // added to suppress. Held numbers are the caller's own input, so naming
  // them back costs what `held=` costs and is what makes the mistake visible
  // on the tick that made it rather than after the cascade has stalled.
  const detail = `merge-queue=${s.mergeQueue} held=${s.mergeHeld}`
    + (s.mergeIgnored.length ? ` ignored=${s.mergeIgnored.join(",")}` : "");
  // Caller-stated for the same reason as the reviewer row above: one source,
  // nothing to disagree with, and nothing added to the printed line.
  const row = (action, extra = "") => ({
    role: "merge-bot", actual: s.mergeBotLive, target: 1, provenance: STATED,
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

// Does this tick ask the controller for anything?
//
// The heartbeat's back-off needs to know "was there nothing to do", and the
// tempting shortcut — back off whenever the output is byte-identical to the
// last tick — is WRONG in the one direction that matters. A tick printing
// `DISPATCH 1` every five minutes because the controller has not acted on it is
// byte-identical each time, and backing off there would stretch the interval
// while work sat in the pool: #3's stall, reintroduced by the very thing added
// to cure it. So identity decides whether to FOLD the output; only this
// predicate decides whether to back off.
//
// DISPATCH, RE-SHORTLIST and REFUSE are the actions naming work the controller
// can do unattended. AT CAP, IDLE OK and HOLD are all "correctly doing
// nothing".
// `SUGGEST /triage` is deliberately NOT actionable: it asks a maintainer to
// tick tickets, and on the unattended overnight run this heartbeat exists for
// there is nobody to ask — treating it as work would pin the interval at the
// base all night for a request no one can answer. It still PRINTS, because the
// fold is keyed on the output changing, so the suggestion is seen once.
//
// REFUSE is the inverse call to that one, and for the opposite reason:
// re-opening the pool, or falling back to the stated counts, is something the
// controller can do on its own. It is also the row whose REPEAT must never buy
// a longer interval — a blind implementer row backing off tick after identical
// tick is #3's stall exactly, wearing the pool's name.
export function actionable(rows) {
  return rows.some((r) => /^(DISPATCH|RE-SHORTLIST|REFUSE)/.test(r.action));
}

// --------------------------------------------------------------------------
// I/O. Everything below runs only as a CLI — importing this file must never
// parse argv or touch the network, or the pure half stops being unit-testable.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { makeDie, isDigits } from "./arg.mjs";
import { statePath, readState, writeState } from "./fleet-state.mjs";

const NAME = "fleet-tick";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Open PRs read per tick. At exactly this many the list may be truncated and
// nothing in the result says so, so it refuses — "no silent caps", same rule
// candidates.mjs enforces on its own query.
const PR_LIMIT = 200;

// die() shared with the other fleet scripts (writeSync-based, pipe-safe —
// see arg.mjs for the #176/#328/#363 rationale). This file parses its own
// options with node:util's parseArgs rather than arg()/has() — see OPTIONS
// below — so die() and the isDigits() rule int() calls are all it shares.
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
  // The heartbeat's half of the contract. Both default, so the two shipped
  // edge invocations need no new flags and their behaviour is unchanged.
  //
  // `--fold-unchanged` prints ONE line instead of three when this tick asks for
  // nothing and says exactly what the last one said. That is what makes an
  // unattended night affordable: ~26 wakes that each cost a line rather than a
  // reconcile. It is opt-in because folding is wrong on an edge — a merge-side
  // tick is read by a controller that just acted and needs the full rows.
  "fold-unchanged": { type: "boolean", default: false },
  // Path override, for tests. An empty value cannot be told from an absent one
  // under parseArgs, and no path is legitimately empty, so empty resolves to
  // the default — unlike `--merge-holds ""`, where the empty string had a
  // plausible-but-wrong reading ("nothing is held") worth refusing.
  state: { type: "string", default: "" },
};

// Why each caller-stated input has no default, quoted back at whoever forgot
// it. Every entry says the same thing about a different state: the controller
// holds it, the repo does not record it, and a guess fails in both directions.
const LIVE_WHY =
  "Live member counts and the pool are the CONTROLLER's state: " +
  "the ledger records a dispatch, never a liveness, so nothing in the repo can be read for them. " +
  "There is no safe default — 0 would dispatch a full cap off a forgotten flag, the cap would hold forever, " +
  "and both are silent.";

const WHY = {
  // The four live counts share one reason, but each is keyed by its own flag
  // name rather than reached through a fallback: a fallback is what lets a
  // flag added later borrow someone else's rationale, silently and correctly-
  // looking, and it is unpairedFlags() below that turns the omission loud.
  implementers: LIVE_WHY,
  reviewers: LIVE_WHY,
  "merge-bots": LIVE_WHY,
  pool: LIVE_WHY,
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

// An option with no `default` is caller-stated, so it must carry its own
// reason. Nothing but spelling ties an OPTIONS key to a WHY key, and a
// string-key miss is the quietest kind: without this, a flag added to OPTIONS
// alone would print a rationale belonging to another flag, and a renamed WHY
// key would print `undefined` after "is required." — both at the usual exit 2,
// both looking like a working refusal. Exported so the pairing is a test's
// subject and not only an import-time side effect.
export function unpairedFlags(options, why) {
  return Object.keys(options).filter((f) => options[f].default === undefined && !(f in why));
}

const unpaired = unpairedFlags(OPTIONS, WHY);
if (unpaired.length) {
  throw new Error(`${NAME}: required flags with no WHY entry: ${unpaired.map((f) => `--${f}`).join(", ")}`);
}

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
    // No fallback: the guard above proves the entry exists, so a miss here
    // cannot be reached rather than being papered over with another flag's text.
    if (raw === undefined) die(`--${name} is required. ${WHY[name]}`);
    // #878: the digits rule, called rather than restated — it lived here as
    // `/^\d+$/` and in ci-state.mjs as `/^[0-9]+$/`, two spellings of one
    // invariant. The wording below stays this file's own, per arg.mjs: what
    // travels is the rule, never the refusal text.
    //
    // Digits, not Number(): `Number("")` is 0 and `Number.isInteger(0)` is
    // true, so `--pool ""` — the shape an unset shell variable produces —
    // would read as a genuine, empty pool. `String(raw).trim()` stays here
    // too, because parseArgs hands over a value arg() would already have
    // refused through isFlagLike.
    if (!isDigits(String(raw).trim())) die(`--${name} must be a non-negative integer, got '${raw}'`);
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
    // The guard above has already ruled out every shape that is not a comma
    // list of optionally-`#`-prefixed numbers, so the digits are the parse.
    return t.match(/\d+/g).map(Number);
  };
  return {
    implLive: int("implementers"), reviewerLive: int("reviewers"), mergeBotLive: int("merge-bots"),
    pool: int("pool"), reviewsReady: int("reviews-ready"), mergeHolds: holds(),
    implCap: cap("implementer-cap"), reviewerCap: cap("reviewer-cap"),
    fold: values["fold-unchanged"], state: values.state || statePath(NAME),
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
  // Named once, so the backlog below re-states the sign-off test rather than
  // re-deriving "not queued" by identity membership over the array it just
  // built. Same answer, and one place to read what "queued" means.
  const isQueued = (p) => p.labels.some((l) => l && l.name === "ready-to-merge");
  const queued = prs.filter(isQueued);
  // A held number the queue does not contain is ignored, not refused: the
  // ordinary way a hold ends is the lower PR merging and the candidate merging
  // behind it, which leaves the caller quoting a number that has left the
  // queue, and a tick that refuses on the happy path is worse than one that
  // subtracts nothing.
  const mergeHeld = queued.filter((p) => holds.includes(p.number)).length;
  // Ignored, but never unnamed — the merge-bot row prints these back. Which is
  // the whole difference between "nothing is held" and "you spelled it wrong".
  const mergeIgnored = holds.filter((n) => !queued.some((p) => p.number === n));

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
  // That transient under-count is not the only one, and the other is
  // permanent: a PR that goes through the fleet's own review cycle while
  // closing no issue is invisible here for its whole life. Those exist — `gh
  // pr list --state merged --json closingIssuesReferences,labels` returns
  // merged PRs carrying `ready-to-merge`, the fleet's own sign-off, with an
  // empty closing set, and each was review work while it was still
  // unlabelled. So this clause swaps a permanent OVER-count for a permanent
  // UNDER-count, deliberately and not by oversight: the over-count starves
  // implementers for the rest of a run, which is the harm #590 measured,
  // while the under-count only lets an extra PR into a review-bound pipeline.
  // If that ever bites, widen it with a second clause — a fleet label — and
  // never by dropping the closing-issue one.
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
    (p) => !isQueued(p) && p.closingIssuesReferences.length > 0,
  ).length;
  return { mergeQueue: queued.length, mergeHeld, mergeIgnored, reviewBacklog };
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
  const { mergeHolds, fold, state: path, ...c } = counts();
  // Both reads happen before anything prints: a partial tick is worse than no
  // tick, because half a reconcile still reads like a reconcile.
  const { mergeQueue, mergeHeld, mergeIgnored, reviewBacklog } = prState(mergeHolds);
  const rows = reconcile({ ...c, mergeQueue, mergeHeld, mergeIgnored, reviewBacklog, supply: supply() });
  const lines = formatLines(rows);

  // The back-off streak and the fold digest, written on EVERY tick including
  // the two merge-side edges. An edge tick that dispatched is the clearest
  // possible "there is work here", so letting only heartbeat ticks reset the
  // streak would leave a long interval armed straight after a busy wave.
  //
  // Digest, not the lines themselves: the file is read by a human when the beat
  // misbehaves, and three padded rows per tick would bury the two numbers that
  // explain the interval.
  const prev = readState(path, NAME);
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  const acts = actionable(rows);
  writeState(path, NAME, prev, { quiet: acts ? 0 : prev.quiet + 1, digest });

  // Fold only when BOTH hold: nothing to act on, and nothing new to say. Either
  // one alone still prints in full — an unchanged `DISPATCH 1` is work going
  // unclaimed, and a changed idle row is the pipeline moving.
  if (fold && !acts && digest === prev.digest) {
    console.log(`fleet-tick: unchanged, nothing to act on (quiet=${prev.quiet + 1}) — full rows on the next change`);
    return;
  }
  for (const line of lines) console.log(line);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
