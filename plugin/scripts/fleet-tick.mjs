#!/usr/bin/env node
// The reconcile tick. run-team's wake table is an event loop, and implementer
// refill was wired as an EDGE — "a member finished → refill its slot". That
// edge dies the moment live implementers reach 0, because 0 implementers emit
// no completion event, and "free capacity + a non-empty pool" is a LEVEL
// condition an edge-triggered loop cannot observe once it stops changing. Measured:
// implementers sat at 0/target with pool 1 and ~57 `ready-for-agent` in supply
// until a human asked why nothing was being implemented. No error, no warning.
//
// So compute the deficit instead of remembering it. Every wake ends in one
// invocation (record, tick, act, beat), and each prints
// actual/target and a named ACTION per role — `PULL #<n> — pull.mjs next --head
// <n>`, one row per head, `DISPATCH
// fix-pr PR#<pr>`, `DISPATCH review PR#<pr>`, `DISPATCH merge-bot`, `HOLD (…)`,
// `REFRESHED shortlist: …` — with run-team's guards applied in code rather than
// recalled from its table. You cannot forget what a script prints at you. A
// drained run with nothing left in flight ends on one more: `ACTION: run over`,
// naming the stop the controller records last.
//
// WHERE THE NUMBERS COME FROM — nobody states them:
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
//             holds (`held-behind:#M`, and `conflict-hold:#<pr>`, written by
//             the merge bot or by the controller off a `CONFLICT` line),
//             merge parks (`parked=<head>:<body digest>:<reason>`, written by
//             `fleet-event.mjs merge-bot-report`), tier mismatches and the
//             drain marker
//             all come off it, and so does the ledger half of the In-flight
//             count: every claimed ticket whose newest `impl-` member is live,
//             or settled `killed`/`tier-mismatch` and so owed a replacement,
//             with no open issue-closing PR yet. A newest member settled
//             `blocked` counts nothing. A missing ledger is a fresh run: zero
//             rows.
//   shortlist `.fleet/shortlist.json`, shortlist.mjs's output, resolved against
//             the git common dir as ledger.mjs resolves the ledger. Its
//             entries minus every ticket with an `impl-` row, or an `excluded`
//             row whose premise still holds, are the heads a PULL names; its
//             `scanned` is the supply. Its `dropped`, the rows candidates.mjs's
//             to-spec filter removed before `scanned` was counted, is named on
//             the implementer row as `specs-dropped=` and counts toward
//             nothing. Missing or unparsable is depth 0 and a
//             refresh, never a refusal: the depth only ever bounds PULLs
//             downward. A file with no `dropped` names no drops.
//   gh        The open PRs, by label, by whether they close an issue, by
//             GitHub's `mergeable`, and by head and body — the merge queue,
//             which PRs are owed a review, which conflict, which queued PR
//             still matches the head and body it was parked at, and the PR
//             half of the In-flight count:
//             every open PR that closes an issue, whoever opened it and
//             whatever its state. Also, for each in-flight `review=` token
//             whose PR the open list does not carry, and for each ticket's
//             latest settled `impl-*=PR#<M>` PR the open list does not carry,
//             that PR's state (one `gh api graphql` read per hundred PRs): a
//             review cannot be running against a finished PR, so its dangling
//             token is not a review unit, and a PR CLOSED unmerged prints an
//             ESCALATE line for its ticket. And, for each ticket holding the
//             implementer row on a tier mismatch, owed a replacement, or whose
//             keyed PR read CLOSED or unread, whether its issue is CLOSED (`gh
//             issue view`): a closed ticket's mismatch holds nothing, its owed
//             replacement is not in flight, and its PR prints no line.
//   main      The main checkout against the run-start baseline
//             `.fleet/main-checkout.sha`, through main-checkout.mjs.
//             Anything but `clean` — dirty, unknown, no baseline — prints one
//             MAIN-CHECKOUT-* line and holds every dispatching row until the
//             maintainer clears it; it never refuses the tick.
//   phase0    `.fleet/phase0.json`, phase0.mjs's receipt, through
//             phase0-receipt.mjs. Missing, unreadable, a `run` other than
//             the controller record's `at`, one whose controller has exited
//             or cannot be judged, or a step `failed`, `pending` or absent
//             prints one PHASE0-INCOMPLETE line naming what is not done and
//             holds every dispatching row, ahead of the main-checkout reason;
//             it never refuses the tick. A step's `drift` or `unanswered`
//             and a `fold-in` NEED are advice, named on the line and holding
//             nothing. The receipt's `session` fills the tier hold's step.
//   guard     `.fleet/cost-guard.json` beside the shortlist, pr-cost.mjs
//             --guard's verdict on the implementer cells. Printed as the
//             `router` row and never acted on here: a missing or unreadable
//             file reads DEFAULT-ONLY, the way the router (not in the tree
//             yet) is to read it. pr-cost.mjs writes the main
//             workspace's file by default, the one read here.
//   seen      `seen` in the heartbeat's state file, this script's own key:
//             when it first saw each live token. The ledger records that a
//             member was dispatched, never when, so the age of a live token
//             exists nowhere else. A token live past its family's threshold
//             prints one `CHECK-LIVENESS` line — advice to the controller to
//             take the registry census, never an action: it resets no
//             `quiet`, changes no row and frees no slot, and the tick never
//             settles or kills anything.
//   reports   `<scratch>/reports/<member>.json`, the report file a member
//             writes beside the message it sends, for every live member
//             token. `<scratch>` is the phase-0 receipt's `scratch`, else
//             `--scratch`; with neither the check is skipped with one stderr
//             line. A file on disk that validates against its member family's
//             report schema prints one `SETTLE <member>` line naming the
//             `ledger.mjs settle <member> --from-report` it is for. One whose
//             `member` is not its filename's prints REPORT-MISMATCH instead;
//             one that is there but cannot be read prints REPORT-UNREADABLE;
//             one that names its own member and fails its family's schema
//             prints REPORT-INVALID with the first violation, because
//             `settle --from-report` refuses such a file. Advice, like
//             CHECK-LIVENESS: the tick settles nothing. A review runner has no
//             report schema and files none, so no `review=` token is looked
//             up; a member with no schema is never checked against one.
//   pulls     `<scratch>/impl-<N>/pull.json`, pull.mjs's record of a Pull, for
//             every head on the shortlist, `<scratch>` as for the report
//             files: read before the refresh is judged, and again for the
//             heads a refresh replaced them with. A question standing prints
//             `PULL #<N> (Q<n> pending — pull.mjs answer <N> <qid> …)` in
//             place of the fresh row, with ` (stale)` once the file is older
//             than `--pull-stale-minutes`; a Pull that dispatched with the
//             head still holding no `impl-` row prints `(dispatched, row
//             missing — ledger.mjs row …)`. A Pull that ended in this run's
//             session (the ticket left, or its claim was released) names no
//             row: `pull.mjs next` skips it, `next --head` would start the
//             ticket over, so the next head fills the slot. Nor is it counted
//             in `unclaimed=` or toward the short-queue refresh, so a
//             shortlist of ended heads refreshes. A Pull that left on an
//             exclusion (its reason starts `excluded ·`) is no such end: its
//             head is counted and Pulled again once the exclusion lifts. A
//             record from another
//             phase-0 session, or one unreadable or absent, is the fresh row:
//             `pull.mjs next` starts or resumes it.
//   session   The listing of the session directory omp writes one
//             `<member>.jsonl` transcript into per dispatched member: this
//             run's phase-0 receipt's `session`, else `--session`; with
//             neither the check is skipped with one stderr line. One readdir
//             per tick, and no file in it is read. A `<stem>.jsonl` whose stem
//             is a member name the ledger records nowhere — no row token, no
//             `## Dispatched` entry, no `## Retired` line — prints
//             `UNRECORDED <stem>`; a live member token first seen more than
//             `--no-transcript-after` minutes ago with no file prints
//             `NO-TRANSCRIPT <member>`. The receipt's directory not there yet
//             holds no transcript; a `--session` one that is not there, like
//             one that cannot be listed, skips the check with one stderr line.
//             Advice, like CHECK-LIVENESS.
//
// The pure half below is `reconcile()` over the counts `deriveRun()` reads off
// the ledger; main() does the I/O. Split so the guard table and the reading are
// both unit-testable without a network.

import { parseMember, parseToken, premisesOf, rowNums, nextRetry, readRetired, pullEnded, REVIEW, REVIEWED } from "./ledger-grammar.mjs";

// The implementer and reviewer rows' TARGET is the In-flight bound; the merge
// bot's is 1. Availability of work belongs in the ACTION, not the target: a
// reviewer target that shrank to the backlog would print `0/0 → idle` and read
// as "correctly sized" for the exact drained state that is the defect.
export function reconcile(s) {
  const rev = reviewers(s);
  // The conflict rows only ask the controller to write a record — never to
  // dispatch — so they stand outside the dispatch hold: the fix-applier a
  // conflict hold leads to obeys the hold through its own role's row. The
  // closed-PR rows dispatch nothing either.
  return [
    ...dispatchHold(s, [...implementers(s), ...rev.rows]),
    ...rev.conflictRows,
    ...prClosedRows(s),
    ...dispatchHold(s, [mergeBot(s)]),
    ...shortlistRows(s),
    ...routerRows(s),
  ];
}

// A ticket whose PR closed unmerged while its issue stays open: unknown
// intent, so the line is the maintainer's and not actionable. One line per
// ticket, beside the implementer row and never in it — it takes no slot and
// counts toward no bound. While a member on PR M is live the line names it:
// nothing resolves the ticket until that member settles. A state probe that
// could not answer prints its own line, and the next tick probes again.
function prClosedRows(s) {
  const live = (k) => (k.live.length ? ` — ${k.live.join(", ")} live` : "");
  return [
    ...s.prClosed.map((k) => ({
      role: "tickets", action: `ESCALATE pr-closed #${k.n} PR#${k.pr}${live(k)}`, acts: false,
      detail: `PR#${k.pr} closed unmerged and #${k.n} is open: the maintainer's — dispatch nothing for #${k.n}`,
    })),
    ...s.prUnchecked.map((k) => ({
      role: "tickets", action: `ESCALATE pr-unchecked #${k.n} PR#${k.pr}`, acts: false,
      detail: `gh could not read PR#${k.pr}'s state; read again next tick`,
    })),
  ];
}

// A main checkout changed since the run's baseline — or one the tick
// could not compare — holds every DISPATCHING row: one HOLD per role,
// keeping its counts, in place of whatever it would have dispatched. Placed
// over the computed rows rather than inside each role, so no role's own
// guards can outrank it. Anything but an explicit `clean` holds: a missing
// answer is not a clean one. Dirty and unknown are the maintainer's to clear
// (main-checkout.mjs's header), so they are not actionable — the same reason
// `SUGGEST /triage` is not. A missing baseline is the controller's own
// Phase 0 step, so that one asks it to act.
const MAIN_CHECKOUT_HOLD = { dirty: "main checkout dirty", absent: "main checkout no baseline" };
// The reason a main-checkout answer holds dispatch on, or null for `clean` —
// the one wording the HOLD rows and the folded line both carry.
function mainCheckoutHoldReason(mainCheckout) {
  const state = mainCheckout?.state ?? "unknown";
  if (state === "clean") return null;
  return MAIN_CHECKOUT_HOLD[state] ?? "main checkout unknown";
}
// A phase 0 this run has not finished holds the same rows the same way, and
// outranks the main-checkout reason on them: the baseline is one of its
// steps. Only a gate that answered `held: false` lets dispatch through — no
// answer is not a finished phase 0. Not actionable, so the fold carries it
// across an unattended night; a missing baseline under it still asks the
// controller to act, as it does alone.
const PHASE0_HOLD = "phase 0 incomplete";
// Every reason dispatch is held on this tick, outermost first.
function holdReasons(s) {
  return [s.phase0?.held === false ? null : PHASE0_HOLD, mainCheckoutHoldReason(s.mainCheckout)].filter((w) => w !== null);
}
function dispatchHold(s, rows) {
  const [why] = holdReasons(s);
  if (why === undefined) return rows;
  const acts = s.mainCheckout?.state === "absent";
  const held = [];
  for (const r of rows) {
    if (held.some((h) => h.role === r.role)) continue;
    held.push({ ...r, action: `HOLD (${why})`, acts });
  }
  return held;
}

// `acts` is on the row, set where the ACTION is chosen: the heartbeat backs off
// on "nothing to act on" and never on "output unchanged", and the
// branch that picks the ACTION is the one place that knows which it is.
const mkRow = (role, actual, target, detail) => (action, { acts = false, extra = "" } = {}) => ({
  role, actual, target, action, acts, detail: extra ? `${detail} — ${extra}` : detail,
});

// The clearing step a tier hold names in its detail. The tick reads no
// transcript; the session directory is the phase-0 receipt's, which
// tier-check.mjs reads itself when an entry omits it. Without a receipt of
// this run, `<session>` stays a placeholder the controller fills in, as
// `<file>` does — one batch file, one entry per held member, the shape under
// **The batch file is a JSON array, one entry per dispatched member** in
// run-team/references/tick-rows.md.
const tierCheckStep = (members, session) => "run ~/.fleet/bin/fleet-run tier-check.mjs --batch <file> with "
  + JSON.stringify(members.map((member) => (session ? { member } : { member, session: "<session>" })));

// A mismatch clears when the next attempt on the ticket is dispatched at its
// row's tier: ledger-grammar.mjs's nextRetry(), one letter past the highest
// any impl member of that ticket has used, null past `-z`.
function replaceStep(held, implNames) {
  const named = [], stuck = [];
  for (const name of held) {
    const next = nextRetry(name, implNames);
    if (next === null) stuck.push(name);
    else named.push(next);
  }
  return [
    named.length ? `dispatch ${named.join(", ")} ${named.length > 1 ? "each " : ""}at its row's tier` : "",
    stuck.length ? `${stuck.join(", ")} ${stuck.length > 1 ? "have" : "has"} no retry letter left` : "",
  ].filter(Boolean).join("; ");
}

// `specs-dropped=#<n> #<n> (to-spec: User Stories heading)`, one clause per
// reason, or "" when nothing was dropped. A dropped ticket never reaches
// `supply`, so without this an all-specs queue reads as no work at all.
function specsDropped(dropped) {
  if (!dropped.length) return "";
  const by = new Map();
  for (const { n, reason } of dropped) by.set(reason, [...(by.get(reason) ?? []), `#${n}`]);
  return `specs-dropped=${[...by].map(([reason, ns]) => `${ns.join(" ")} (${reason})`).join(", ")}`;
}

// The question numbers SKILL.md's phase 1 gives pull.mjs's questions. The row
// names the number and the command names the qid, which is what `pull.mjs
// answer` takes; a qid with no number here is named by itself.
const QUESTION_NUMBERS = { staleness: "Q1", close: "Q1b", decided: "Q2", collision: "Q3" };

/**
 * Where a head's Pull stands, off its `pull.json` record as parsed, for the
 * PULL row: `{kind: "pending", qid, stale}`, `{kind: "dispatched", text}` with
 * the text the Pull's own `ledger.mjs row` wrote (null when it recorded none),
 * `{kind: "ended"}` for a Pull that left or was released, or null for the
 * fresh row. A Pull that left on an Exclusion (its reason starts `excluded ·`)
 * is the fresh row too: it is no end, since the head claims a PULL row again
 * once the tick's own lift logic admits it. `since` is the file's mtime and
 * `session` this run's phase-0 session, null when the receipt names none.
 */
export function pullOf(record, { session, since, now, staleMinutes }) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  // pull.mjs ends a record from another phase-0 session whatever it says, and
  // starts the ticket afresh.
  if (session !== null && record.session !== session) return null;
  // pull.mjs's `next` skips a Pull that ended in this run, and `next --head`
  // would start the ticket over: the head is no one for a PULL row to name.
  // `pullEnded` is the one test both read. A Pull that left on an Exclusion is
  // no such end, so it falls through to the fresh row. While a `behind-pr:#M`
  // premise stands, the ledger claims the head and it never reaches here; a
  // `behind-issue` or branch-named premise only the refreshed shortlist keeps
  // out, by dropping its ticket (unclaimed), so after a failed refresh the
  // head can get a PULL row that `pull.mjs` leaves again. Once the premise
  // lifts, `next` takes it again.
  if (pullEnded(record)) return { kind: "ended" };
  if (record.status === "running" && typeof record.pending?.qid === "string") {
    return { kind: "pending", qid: record.pending.qid, stale: now - since > staleMinutes * 60_000 };
  }
  if (record.status === "dispatched") {
    const row = Array.isArray(record.commands)
      ? record.commands.findLast((c) => c?.step === "row" && c.exit === 0 && Array.isArray(c.cmd))
      : undefined;
    return { kind: "dispatched", text: typeof row?.cmd[3] === "string" ? row.cmd[3] : null };
  }
  return null;
}

// A head's PULL action. A question standing is a Pull in progress: the fresh
// row there would ask it twice. A dispatched Pull whose head still holds no
// `impl-` row should not occur, and must not read as a fresh Pull either.
function pullAction(n, p) {
  if (p?.kind === "pending") {
    return `PULL #${n} (${QUESTION_NUMBERS[p.qid] ?? p.qid} pending — pull.mjs answer ${n} ${p.qid} …)${p.stale ? " (stale)" : ""}`;
  }
  if (p?.kind === "dispatched") return `PULL #${n} (dispatched, row missing — ledger.mjs row ${n} ${p.text === null ? "…" : JSON.stringify(p.text)})`;
  return `PULL #${n} — pull.mjs next --head ${n}`;
}

// The heads a PULL row could name: a head whose Pull ended in this run takes
// no slot, and the next head takes it. A Pull that left on an Exclusion is no
// such end (pullOf). Order kept, so the slots fill oldest first.
function pullable(heads, pulls) {
  return heads.filter((n) => pulls?.get(n)?.kind !== "ended");
}

// The implementer rows: one per head a free slot Pulls, else the one row
// saying why none is pulled. `unclaimed=` counts the heads a PULL row could
// name. A refresh whose trigger text names a count carries it as `unclaimed`,
// and the row prints that count, not the refreshed file's: one tick never
// prints two different counts.
function implementers(s) {
  const dropped = specsDropped(s.dropped);
  const heads = pullable(s.heads, s.pulls);
  const counted = s.refresh?.unclaimed ?? heads.length;
  const one = mkRow("implementers", s.inFlight, s.bound,
    `implementers=${s.inFlightImpl} prs=${s.inFlightPrs} unclaimed=${counted} supply=${s.supply ?? "?"}`
    + (s.shortlistStatus === "ok" ? "" : ` shortlist=${s.shortlistStatus}`)
    + (dropped ? ` ${dropped}` : ""));
  const row = (...a) => [one(...a)];

  // Drain stops supply and nothing else. Read from the file, so
  // a replacement controller that never saw the drain is held by it too.
  if (s.draining !== null) return row("HOLD (draining)");
  // Held until a replacement at the right tier is dispatched. The
  // controller can fix this unattended, so the row asks it to — and names the
  // replacement in its detail, since the step lives otherwise only in
  // SKILL.md prose, which is what a compaction loses.
  if (s.tierMismatch.length) {
    return row(`HOLD (tier mismatch ${s.tierMismatch.join(" ")})`, { acts: true, extra: replaceStep(s.tierMismatch, s.implNames) });
  }
  // Held until tier-check.mjs has run on the newest implementer and written
  // its verdict to the ledger — a Pull on top of an unchecked
  // dispatch repeats whatever it got wrong. `--apply` runs the check itself
  // before this row is read; the row is the controller's to act on when the
  // tick ran without `--apply`, or the check wrote no verdict, so it asks to
  // act, with the command in the detail.
  if (s.tierUnchecked.length) {
    return row(`HOLD (tier unchecked ${s.tierUnchecked.join(" ")})`, { acts: true, extra: tierCheckStep(s.tierUnchecked, s.phase0?.session) });
  }

  // The In-flight bound: n tickets between their Claim and their PR's merge,
  // at or over B, hold every Pull until a merge brings n below B. Quiet — a
  // merge is what clears it, and the controller has nothing to do meanwhile —
  // except for a ticket whose implementer was killed: it counts with no PR
  // that could merge, so the dispatch of its replacement is what clears it,
  // and the row asks the controller for it.
  // A replacement implementer is never a Pull, so no branch here reads it.
  // The merge queue and the review backlog never gate this row: a deep
  // ready-to-merge queue adds no rebases per PR, and a review owed is the
  // reviewer row's DISPATCH on this same tick.
  if (s.inFlight >= s.bound) {
    const hold = `HOLD (in-flight ${s.inFlight}/${s.bound})`;
    return s.owedCounted.length ? row(hold, { acts: true, extra: replaceStep(s.owedCounted, s.implNames) }) : row(hold);
  }

  if (heads.length) return heads.slice(0, s.bound - s.inFlight).map((n) => one(pullAction(n, s.pulls?.get(n)), { acts: true }));

  // Nothing to Pull even after a refresh: no unclaimed head, or only heads
  // whose Pull ended in this run, which `pull.mjs next` skips — a Pull that
  // left on an Exclusion is no such end (pullOf). `SUGGEST /triage` asks a
  // MAINTAINER to tick tickets, and on the unattended night the heartbeat
  // exists for there is nobody to ask — so it prints (the fold shows it once)
  // but is not actionable, or it would pin the interval at the base all night.
  return row("SUGGEST /triage, hold idle");
}

// Reviewer units: an in-flight review = 1, each fix-applier = 1. Every due
// unit is dispatched, no cap: a PR holds at most one live review unit, so
// units stay within the open PRs. The In-flight bound gates Pulls, not these,
// so a run that inherited more than B PRs dispatches a unit for each.
// Named in priority order — fix-appliers first, then reviews, oldest first —
// because finishing what is started beats starting more.
function reviewers(s) {
  const detail = `reviews=${s.reviewsLive} fix-pr=${s.fixLive} fix-due=${s.fixDue.length}`
    + ` review-due=${s.reviewDue.length}`;
  const row = mkRow("reviewers", s.reviewsLive + s.fixLive, s.bound, detail);
  const fixes = s.fixDue;
  const reviews = s.reviewDue;
  const prs = (ns) => ns.map((n) => `PR#${n}`).join(" ");

  const rows = [];
  if (fixes.length) rows.push(row(`DISPATCH fix-pr ${prs(fixes)}`, { acts: true }));
  if (reviews.length) rows.push(row(`DISPATCH review ${prs(reviews)}`, { acts: true }));
  // A finisher settled `labelled` on a PR the open list shows without
  // `ready-to-merge`. One such attempt since the controller's last deliberate
  // removal gets one fresh finisher; a second one escalates, never a third
  // dispatch. Finishers are not review units, so neither waits on one.
  const names = (us) => us.flatMap((u) => u.labelled).join(", ");
  const repair = s.unlabelled.filter((u) => u.labelled.length === 1);
  const stuck = s.unlabelled.filter((u) => u.labelled.length > 1);
  const unlabelledRows = [];
  if (repair.length) {
    unlabelledRows.push(row(`DISPATCH finisher ${prs(repair.map((u) => u.pr))}`,
      { acts: true, extra: `${names(repair)} settled labelled; no ready-to-merge on the PR` }));
  }
  if (stuck.length) {
    unlabelledRows.push(row(`ESCALATE unlabelled ${prs(stuck.map((u) => u.pr))}`,
      { extra: `${names(stuck)} settled labelled since the last label-off; still no ready-to-merge` }));
  }
  // An open PR the run tracks that GitHub reads CONFLICTING, with no hold on
  // record and nobody working it: the controller writes the hold the merge
  // bot would, and the tick turns it into `DISPATCH fix-pr` from then on.
  // Past two landed conflict fix-appliers it is a treadmill, handed to a human
  // instead — no hold, no fix-applier. Neither row is a review unit, and
  // neither stands aside for IDLE OK: that row is the one a hold replaces. They
  // are returned beside `rows`, not among them, so a main-checkout hold never
  // turns a record-only line into a HOLD.
  const conflictRows = [];
  if (s.conflicts.length) {
    const record = s.conflicts.map((n) => `~/.fleet/bin/fleet-run ledger.mjs row <key> "<text> · conflict-hold:#${n} (conflict: mergeable=CONFLICTING)" on the row naming PR#${n}`);
    conflictRows.push(row(`CONFLICT ${prs(s.conflicts)}`,
      { acts: true, extra: `GitHub reads CONFLICTING; ~/.fleet/bin/fleet-run ledger.mjs read, then ${record.join("; ")}` }));
  }
  if (s.conflictEscalate.length) {
    conflictRows.push(row(`ESCALATE conflict ${prs(s.conflictEscalate)}`,
      { extra: "GitHub reads CONFLICTING again after two conflict fix-appliers landed; comment on the PR and flag it for a human — no hold, no fix-applier" }));
  }
  if (!rows.length && !unlabelledRows.length) rows.push(row("IDLE OK"));
  rows.push(...unlabelledRows);
  return { rows, conflictRows };
}

function mergeBot(s) {
  // Cap is 1 by invariant, not by configuration.
  const parked = s.mergeParked;
  const row = mkRow("merge-bot", s.mergeBotLive, 1,
    `merge-queue=${s.mergeQueue} held=${s.mergeHeld}${parked.length > 0 ? ` parked=${parked.length}` : ""}`);
  if (s.mergeBotLive >= 1) return row("AT CAP");
  if (s.mergeQueue === 0) return row("IDLE OK");
  // `ready-to-merge` is the author's sign-off and nothing more. A bot
  // dispatched against a queue whose candidates are all held — behind a lower
  // open PR, or on a conflict merge-bot already refused to force — or parked
  // on a refusal only a human edit clears spends a whole member re-deriving a
  // verdict already recorded.
  if (s.mergeQueue - s.mergeHeld - parked.length <= 0) {
    if (parked.length > 0) {
      return row(`HOLD (parked ${parked.map((p) => `#${p.pr} ${p.reason}`).join(", ")})`, {
        extra: "a park clears on a PR-body acknowledgement `main-gain-removal: <path> <key> - <why>` or a new head"
          + (s.mergeHeld > 0 ? `; ${s.mergeHeld} more held` : ""),
      });
    }
    const why = s.mergeConflictHeld ? "behind a lower PR or on a merge conflict no fix-pr has cleared" : "behind a lower PR";
    return row("HOLD", { extra: `every queued candidate is held ${why}` });
  }
  return row("DISPATCH merge-bot", { acts: true });
}

// The refresh this tick ran, if it ran one. A REFRESHED that changed the list
// is actionable — supply arrived. One that changed nothing is not: every idle
// heartbeat tick refreshes while the shortlist is short of the In-flight
// bound and nothing holds the row, and an
// unconditionally actionable REFRESHED would pin the beat at its base interval
// on exactly the quiet night the heartbeat backs off on. A failed refresh IS
// actionable: a blind implementer row backing off tick after identical tick is
// the drained-queue stall this tick exists to end, exactly.
function shortlistRows(s) {
  const r = s.refresh;
  if (r === null) return [];
  if (!r.ok) return [{ role: "shortlist", action: "REFRESH FAILED", acts: true, detail: `${r.trigger} — ${r.why}` }];
  return [{
    role: "shortlist", action: `REFRESHED shortlist: ${r.entries} entries; ${r.lifted} lifted`, acts: r.changed,
    detail: r.changed ? r.trigger : `${r.trigger}; unchanged`,
  }];
}

// The cost guard's verdict, as pr-cost.mjs --guard wrote it: OK, DEFAULT-ONLY
// (a cell tripped, or no readable guard file — the router then runs the
// default cell alone), or NO VERDICT (the baseline is short of its n). The
// controller has nothing to do about any of them inside a run, so the row
// never acts; it is here so the verdict is printed by code, not recalled.
// Every verdict carries the guard's own `computed_at`: a refresh that failed
// leaves the old file on disk, and only its age says the OK is not current.
// No `router` state at all (a caller that read no guard) prints no row.
export function routerRows(s) {
  const g = s.router;
  if (g === undefined) return [];
  const row = (action, detail) => [{ role: "router", action, acts: false, detail }];
  const run = "run pr-cost.mjs --guard";
  if (g.status === "missing") return row("DEFAULT-ONLY", `cost-guard.json missing — ${run}`);
  if (g.status !== "ok") return row("DEFAULT-ONLY", `cost-guard.json unreadable (${g.why}) — ${run}`);
  const { baseline: b, cells, tripped, verdict, min_n: minN, computed_at: computed } = g.guard;
  const age = `guard computed ${computed}`;
  if (verdict === "none") return row("NO VERDICT", `baseline n=${b.n}/${minN}; ${age}`);
  const pct = (x) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
  const usd = (x) => (x === null ? "n/a" : `$${x.toFixed(2)}`);
  const vs = (c) => `${c.cell} ${usd(c.mean_usd)} vs ${usd(b.mean_usd)}, fail ${pct(c.fail_rate)} vs ${pct(b.fail_rate)}, n=${c.n}/${b.n}`;
  if (verdict === "tripped") {
    const retired = g.guard.retire ? "; every non-default stage-1 cell tripped — the router retires" : "";
    return row("DEFAULT-ONLY", `cost guard: ${cells.filter((c) => tripped.includes(c.cell)).map(vs).join("; ")}${retired}; ${age}`);
  }
  const others = cells.filter((c) => c.cell !== b.cell);
  return row("OK", `${others.length ? others.map(vs).join("; ") : `baseline ${b.cell} ${usd(b.mean_usd)}, n=${b.n}`}; ${age}`);
}

// pr-cost.mjs's guard file, read as the router is to read it: anything but a
// well-formed, self-consistent verdict is not one.
export function readCostGuard(path) {
  if (path === null) return { status: "missing" };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return e.code === "ENOENT" ? { status: "missing" } : { status: "unreadable", why: e.code ?? e.message };
  }
  let guard;
  try { guard = JSON.parse(text); } catch { return { status: "unreadable", why: "not JSON" }; }
  const cellShaped = (c) => c && typeof c.cell === "string" && Number.isInteger(c.n)
    && (c.mean_usd === null || typeof c.mean_usd === "number") && (c.fail_rate === null || typeof c.fail_rate === "number");
  const ok = guard && ["ok", "tripped", "none"].includes(guard.verdict) && typeof guard.computed_at === "string"
    && cellShaped(guard.baseline) && Array.isArray(guard.cells) && guard.cells.every(cellShaped) && Number.isInteger(guard.min_n)
    && Array.isArray(guard.tripped) && guard.tripped.every((c) => typeof c === "string")
    // The verdict is "tripped" exactly when a cell is named, and only a reported cell can be named.
    && (guard.verdict === "tripped") === (guard.tripped.length > 0)
    && guard.tripped.every((c) => guard.cells.some((x) => x.cell === c))
    && (guard.retire === undefined || typeof guard.retire === "boolean");
  return ok ? { status: "ok", guard } : { status: "unreadable", why: "not a guard verdict" };
}

export function formatLines(rows) {
  const w = Math.max(...rows.map((r) => r.role.length));
  return rows.map((r) => r.actual === undefined
    ? `${r.role.padEnd(w)} → ${r.action}   (${r.detail})`
    : `${r.role.padEnd(w)} ${r.actual}/${r.target} → ${r.action}   (${r.detail})`);
}

// Does this tick ask the controller for anything? Identity decides whether to
// FOLD the output; only this decides whether to back off. A tick
// printing `PULL #<n>` every five minutes because the controller has not acted
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

// The `reviewed=` shape before it named a run: it names no result file, so
// nothing can tell which review a dispositions verdict answered. Only a ledger
// written before the plugin update and read after it can hold one.
const REVIEWED_RUNLESS = /^reviewed=[0-9a-fA-F]{7,40}:\d+\/\d+\/\d+$/;
export const HELD = /^held-behind[:-]#?(\d+)$/;
// The durable record that a PR conflicts — written onto the held PR's own
// row by the merge bot, when its local-rebase fallback hits a conflict it would
// not force, or by the controller off this tick's `CONFLICT` line — and
// spelled like `held-behind` so the two read alike. Distinct from an
// Exclusion, which gates a ticket's claim; this gates a PR's merge.
export const CONFLICT_HOLD = /^conflict-hold[:-]#?(\d+)$/;
// The durable record that a merge bot refused a PR on a main-gain hit — a
// refusal only a human edit clears — written onto the PR's own row by
// `fleet-event.mjs merge-bot-report`: `parked=<head>:<body digest>:<reason>`,
// the head and the body digest those the merge gate read when it refused, and
// the reason the gate's `main-gain-removed:<path>` percent-encoded with
// encodeURI, and `#` as `%23`, so the token stays one word and carries no
// `#<n>` a row would read as a PR mention. It parks the PR only while its head
// and body still match: a new head or an edited body lifts it, with no write.
export const PARKED = /^parked=([0-9a-f]{40}):([0-9a-f]{12}):(main-gain-removed:\S+)$/;
// The only gate reason that parks: every other refusal clears without a
// human edit to the PR. A path is any non-empty text, a newline included.
export const PARKS = /^main-gain-removed:./s;
// The digest a park binds a PR body by: gh's `body` string, as gh prints it.
// merge-gate.mjs computes the same digest of the body it read into its
// payload's `bodyDigest`, which is where a park's digest comes from.
export const bodyDigest = (body) => createHash("sha256").update(body).digest("hex").slice(0, 12);
// The park token for a refusal `reason` at `head` with body digest `digest`,
// or null when the reason does not park, the head is not a full commit SHA or
// the digest is not a body digest.
export function parkedToken(head, digest, reason) {
  if (!PARKS.test(reason)) return null;
  const tok = `parked=${String(head).toLowerCase()}:${digest}:${encodeURI(reason).replaceAll("#", "%23")}`;
  return PARKED.test(tok) ? tok : null;
}
// A park token's reason as the gate printed it; a hand-written one that does
// not decode is shown as written.
function parkedReason(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}
// tier-check.mjs's verdict on an implementer, `tier-ok=<member>:<def>`
// or `tier-mismatch=<member>:<def>` — or `tier-unverifiable=<member>:no-transcript`
// for a settled member whose transcript was never written.
const TIER_VERDICT = /^tier-(ok|mismatch|unverifiable)=([^:\s]+):\S+$/;
// dispositions-check.mjs's verdict on a review fix-applier's disposition
// record: `dispositions-ok=fix-pr-<M>[-x]:<run>`,
// `dispositions-mismatch=…`, `dispositions-escalate=…` (a critical or
// important deferral, or a second mismatch on one review, that a human rules
// on) or `dispositions-unchecked=…` (no rule broke, but where a deferral was
// filed could not be read), `<run>` the run of the review the record
// answers, as its `reviewed=` names it. `ledger.mjs dispatch` refuses a
// finisher on anything but an ok. A
// mismatch returns the PR to fixDue for one retry; an escalate is a hold only
// a human answers, so the tick never re-offers the PR for it; an unchecked is
// answered by running the check again, so the tick never offers a
// fix-applier for it either. A token outside this shape is no verdict at all,
// which the gate reads as unchecked: fail closed.
export function dispositionsToken(tok) {
  const m = /^dispositions-(ok|mismatch|escalate|unchecked)=([^:\s]+):(run-[A-Za-z0-9]{8})$/i.exec(tok);
  if (!m) return null;
  const member = parseMember(m[2]);
  if (member === null || member.family !== "fix-pr") return null;
  return { verdict: m[1].toLowerCase(), member, run: m[3] };
}

// Which verdict outranks which when one fix-applier carries more than one for
// a review: the stricter reading wins.
const VERDICT_RANK = { ok: 0, unchecked: 1, mismatch: 2, escalate: 3 };

// A PR's current dispositions verdict against its latest review run: among
// the tokens answering that run, the one from the fix-applier with the
// highest retry suffix ("" < "b" < "c" …) — never row-text position, which a
// `row` rewrite can reorder. One fix-applier carrying two verdicts for one
// review reads as the stricter one. null when no token answers the run — so a
// second review at the same head is answered by none of the first one's
// verdicts.
/** @returns {{verdict: "ok"|"unchecked"|"mismatch"|"escalate", member: string}|null} */
export function currentDispositions(tokens, run) {
  let best = null;
  for (const t of tokens) {
    if (t.run !== run) continue;
    const retry = t.member.retry ?? "";
    const bestRetry = best?.member.retry ?? "";
    if (best === null || retry > bestRetry
      || (retry === bestRetry && VERDICT_RANK[t.verdict] > VERDICT_RANK[best.verdict])) best = t;
  }
  return best === null ? null : { verdict: best.verdict, member: best.member.name };
}

// `label-off=<finisher-pr-M[-x]>` — written by the controller BEFORE it
// takes `ready-to-merge` off PR M on purpose (before approving a push; clearing
// a label left on a moved head), naming the latest finisher attempt. A missing
// label is a finisher's miss only when no such removal accounts for it.
// `undefined` for a token that is not a label-off at all, null for one naming
// no finisher-pr member — `ledger.mjs row` refuses that one at write time, and
// deriveRun refuses a hand-written one.
export function labelOffMember(tok) {
  if (!tok.startsWith("label-off=")) return undefined;
  const m = parseMember(tok.slice("label-off=".length));
  return m !== null && m.family === "finisher-pr" ? m : null;
}

// PRs whose finisher attempts are read off the ledger while the open list shows
// no `ready-to-merge` on them — `unqueued` is the set of open PR numbers without
// it, so the label shape stays the caller's (gh's `{name}` here, plain names in
// compute-board.mjs). A PR's attempts are its `finisher-pr-M` tokens in
// `## Dispatched` and on PR M's own rows; a copy on another PR's row is a
// stray that neither makes nor masks a miss. Settled anywhere among
// those is settled. The STRETCH is the attempts whose retry suffix sorts after
// the highest one a `label-off=` names — suffix order ("" < "b" < …), never
// row position. `attempts` is the stretch in suffix order and `outcome`
// the outcome of its latest attempt (null while that one is live); a PR whose
// stretch is empty is left out.
//
// Lenient on purpose — a malformed token is skipped, never thrown — because
// the cockpit reads the same ledger and flags rather than refuses; deriveRun
// has already refused anything malformed before it calls this.
/** @returns {{pr: number, outcome: string|null, attempts: {name: string, retry: string, outcome: string|null}[]}[]} ascending by PR */
export function latestFinisherAttempts({ rows, dispatched }, unqueued) {
  const attempts = new Map();
  const offs = new Map();
  const add = (t) => {
    if (!t || t.error || t.family !== "finisher-pr") return;
    if (!attempts.has(t.number)) attempts.set(t.number, new Map());
    const byName = attempts.get(t.number);
    const a = byName.get(t.name) ?? { name: t.name, retry: t.retry ?? "", outcome: null };
    if (t.outcome !== null) a.outcome = t.outcome;
    byName.set(t.name, a);
  };
  for (const e of dispatched) add(parseToken(e));
  for (const text of rows) {
    const { pr } = rowNums(text);
    for (const tok of text.split(/\s+/).filter(Boolean)) {
      const off = labelOffMember(tok);
      if (off) {
        const r = off.retry ?? "";
        if (!offs.has(off.number) || r > offs.get(off.number)) offs.set(off.number, r);
      } else {
        const t = parseToken(tok);
        if (t && t.number === pr) add(t);
      }
    }
  }
  const out = [];
  for (const [n, byName] of attempts) {
    if (!unqueued.has(n)) continue;
    const stretch = [...byName.values()]
      .filter((a) => !offs.has(n) || a.retry > offs.get(n))
      .sort((a, b) => (a.retry < b.retry ? -1 : a.retry > b.retry ? 1 : 0));
    if (stretch.length === 0) continue;
    out.push({ pr: n, outcome: stretch.at(-1).outcome, attempts: stretch });
  }
  return out.sort((a, b) => a.pr - b.pr);
}

// PRs whose latest finisher attempt settled `labelled` while the open
// list shows no `ready-to-merge` on them. `labelled` lists every attempt in the
// stretch that settled so, the count the tick splits one repair from an
// escalation on.
/** @returns {{pr: number, labelled: string[]}[]} ascending by PR */
export function unlabelledFinishers(ledger, unqueued) {
  return latestFinisherAttempts(ledger, unqueued)
    .filter((u) => u.outcome === "labelled")
    .map((u) => ({ pr: u.pr, labelled: u.attempts.filter((a) => a.outcome === "labelled").map((a) => a.name) }));
}

// The per-PR fold: every row and `## Dispatched` entry read once into one
// state per PR, shared by every row that resolves to it. deriveRun reads its
// counts off this, and compute-board.mjs reads each card's PR state off the
// same one — a second row→PR join in the cockpit is a second answer to which
// PR a token speaks for. Returns `{members, byPr, verdicts, claimed, excluded,
// malformed}`: `members` the merged record per member name, `byPr` the state
// per PR, `malformed` the indexes of the `rows` a token was skipped on.
//
// Strict by default: a token it cannot read throws LedgerError. `lenient` is
// the cockpit's mode — its contract is that unknown text is flagged, never
// fatal — and skips that token instead, recording its row in `malformed`. A
// skipped `review=` still reads as a live review and a skipped `reviewed=` as
// a returned one at no head, the readings the cockpit has always given them.
export function foldLedger({ rows, dispatched }, open, { lenient = false } = {}) {
  // One entry per member name across `## Dispatched` and every row. A member
  // settled ANYWHERE is settled: `settle` is the only writer of an outcome, and
  // a bare copy beside it is what a whole-line `row` rewrite leaves behind.
  // The one narrowing: a PR-bound member (`fix-pr-M`, `finisher-pr-M`)
  // speaks for PR #M alone, so its outcome counts off `## Dispatched` or off
  // PR #M's own row, never off another PR's — `dispatch` and `settle` write it
  // onto PR #M's row only, so a settled copy elsewhere is a hand-written stray
  // that must not mark PR #M's own live member settled. `rowPr` is the row's
  // PR (`undefined` for `## Dispatched`, which is no PR's row; `null` for a
  // row naming no PR, which settles no PR-bound member); a stray's token
  // still creates the member, live, as before.
  const members = new Map();
  const malformed = new Set();
  const note = (t, where, rowPr) => {
    if (t.error) {
      if (lenient) return false;
      throw new LedgerError(`${where}: ${t.name}: ${t.error}`);
    }
    const m = members.get(t.name) ?? { name: t.name, family: t.family, number: t.number, outcome: null };
    if (t.outcome !== null && (t.bound !== "pr" || rowPr === undefined || t.number === rowPr)) m.outcome = t.outcome;
    members.set(t.name, m);
    return true;
  };
  for (const e of dispatched) {
    const t = parseToken(e);
    if (!t) {
      if (lenient) continue;
      throw new LedgerError(`## Dispatched entry '${e}' is not a member token — fix the ledger by hand before the tick can count from it`);
    }
    note(t, `## Dispatched entry '${e}'`);
  }

  const claimed = new Set();
  const excluded = [];
  const byPr = new Map();
  // tier-check.mjs's verdict tokens, read off whichever row carries
  // them: `tier-ok=<member>:<definition>` on a pass, `tier-mismatch=<member>:…`
  // for a member found mismatched after it had already settled some other way
  // (a live one is settled `tier-mismatch` instead). Neither parses as a member
  // token nor as `review=`/`reviewed=`, so both always reach this loop's own
  // `else` branch below, alongside HELD/CONFLICT_HOLD — one pass over every
  // row's tokens covers all four.
  // `tier-unverifiable=<member>:no-transcript` is the third: a settled member
  // with nothing to check, which clears the unchecked hold and nothing else.
  const verdicts = { ok: new Set(), mismatch: new Set(), unverifiable: new Set() };
  // fix-pr members some row carries settled IN PLACE (`<member>=<outcome>`).
  // `settle` rewrites a token where it stands, so that copy sits where the
  // member was dispatched; a bare copy beside it is what a whole-line `row`
  // rewrite put back, wherever that rewrite chose. Its landing is read off
  // the in-place copy (below), and off a bare one only when no row carries
  // one — settled in `## Dispatched` alone. Only a copy on its own PR's row
  // counts, as in the fold: a settled stray on another PR's row must
  // not keep the owner's bare copy from landing. A malformed token is skipped
  // here and refused by the fold below, in row order, as before.
  const settledInRow = new Set();
  for (const text of rows) {
    const { pr } = rowNums(text);
    for (const tok of text.split(/\s+/)) {
      const t = parseToken(tok);
      if (t && !t.error && t.family === "fix-pr" && t.number === pr && t.outcome !== null) settledInRow.add(t.name);
    }
  }
  for (const [i, text] of rows.entries()) {
    const { keyNum, pr } = rowNums(text);
    const where = `row '${text}'`;
    // One state per PR, shared by every row that resolves to it: a
    // ticket row settled `impl-<n>=PR#<pr>` sorts above PR <pr>'s own `#<pr>` row
    // whenever both exist, and either may carry that PR's tokens — ledger.mjs's
    // memberRowIndex() writes a PR-bound member onto the first row mentioning
    // its PR and onto `#<pr>` only when none does — so the second row continues
    // the first's state rather than losing to it.
    // `conflictOpen`: the row carries a conflict hold no fix-applier has
    // SETTLED (`applied:`/`no-op`) after — never merely dispatched: a live
    // fix-applier is still working the conflict.
    // `reviewFixed`: a REVIEW fix-applier landed after the latest
    // `reviewed=` — one read while no hold stood unresolved. The one read
    // while a hold did is the conflict fix-applier: it rebases and never sees
    // the review file, so it clears the hold and answers no finding. Each
    // fix-applier does one of those jobs once, so its landing folds once per PR
    // (`fixLanded`), however many copies of its token the rows carry.
    // `fixMembers`: every fix-applier on this PR, wherever its token sits —
    // one still unsettled anywhere holds the PR off fixDue, since `dispatch`
    // refuses a second live one on the PR.
    // `reviewedHead`/`reviewedRun`: the latest `reviewed=<head>:…:<run>`.
    // `pastPinHalt`: the latest
    // finisher since that review settled `halted:past-pin` — any
    // later finisher attempt, live or settled, replaces it, and a later
    // returned review answers it. `unverified`: the latest `reviewed=`'s
    // unverified count. `dispositions`: every dispositions verdict a fix-pr
    // member of this PR carries, whatever review it answers — the gate picks
    // by run and retry suffix, never by where a token sits.
    // `workers`: every fix-applier and finisher bound to this PR, and every
    // implementer on a row resolving to it — one still unsettled holds the
    // CONFLICT line off, since it may be pushing to the branch right now.
    const st = (pr !== null && byPr.get(pr)) || {
      inFlight: false, reviewedAny: false, survived: 0, unverified: 0, reviewFixed: false,
      fixMembers: new Set(), fixLanded: new Set(), conflictLanded: new Set(), held: [],
      conflictOpen: false, reviewedHead: null, reviewedRun: null, pastPinHalt: false, dispositions: [], workers: new Set(),
      finishers: new Set(), parked: [],
    };
    // The finisher-pr token currently deciding `pastPinHalt`, picked by
    // retry suffix ("" < "b" < "c" …) — never by row-text position. A
    // `-b` retry can sit before an older `halted:past-pin` token after a row
    // rewrite, and text order must not read the stale one as the live
    // finisher's replacement. Reset at each `reviewed=`, since `pastPinHalt`
    // is defined relative to the latest one (see the comment above `st`).
    let latestFinisher = null;
    for (const tok of text.split(/\s+/).filter(Boolean)) {
      const t = parseToken(tok);
      if (t) {
        if (!note(t, where, pr)) {
          malformed.add(i);
          continue;
        }
        if ((t.bound === "pr" && t.number === pr) || t.family === "impl") st.workers.add(t.name);
        // A settled `failed`/`killed` fix-applier leaves review findings or a
        // conflict unfixed and no successor dispatched — the PR stays fix-due
        // for a `-b` replacement. Only a live attempt, or one that actually
        // landed (`applied:`/`no-op`), holds it off. Read the outcome off the
        // member's merged record (`members`, narrowed above) rather than this
        // row's own copy of the token: "a member settled ANYWHERE is settled",
        // the rule `members` implements for `implLive`/`fixLive`/etc. below,
        // narrowed to the places it speaks for — a later, unrelated `row`
        // rewrite that drops the `=outcome` suffix and puts back a bare copy
        // must not un-settle what actually landed. Which job a landed one did
        // is read off where its token sits:
        // after an unresolved hold it was the conflict fix-applier and clears
        // that hold; otherwise it answered the latest review's findings. A
        // hold reopens `conflictOpen` below and a `reviewed=` resets
        // `reviewFixed`, so only a fix-applier after the latest of each ever
        // counts. Only ONE copy says where: the first in-place settled one,
        // or — none on any row — the first that reads landed. Any other copy
        // folding again would land the one member twice: a stale bare copy
        // after the hold its member's in-place copy preceded clearing that
        // hold, or a second copy after the first cleared the hold answering
        // findings the conflict fix-applier never read. Liveness is not read
        // here at all: a bare copy read before a later row settles its member
        // reads unsettled at that point, so `fixMembers` is judged once every
        // row has been read. A copy reaching this branch has just been
        // recorded into `members` by the `note` above, so its outcome is this
        // token's own unless `## Dispatched` or an earlier row already settled
        // it — never a reason to fall back to the row's own copy. A
        // `fix-pr-<M>` speaks for PR #M alone, as a `finisher-pr` does below:
        // `dispatch` and `settle` write it onto PR #M's row only, so a
        // copy on another PR's row is a hand-written stray this PR reads as
        // absent, and which lends PR #M's own copies no outcome.
        if (t.family === "fix-pr" && t.number === pr) {
          st.fixMembers.add(t.name);
          const o = members.get(t.name).outcome;
          if ((o === "no-op" || /^applied:/.test(o)) && !st.fixLanded.has(t.name)
            && (t.outcome !== null || !settledInRow.has(t.name))) {
            st.fixLanded.add(t.name);
            if (st.conflictOpen) {
              st.conflictOpen = false;
              st.conflictLanded.add(t.name);
            } else st.reviewFixed = true;
          }
        }
        if (t.family === "finisher-pr" && t.number === pr) st.finishers.add(t.name);
        if (t.family === "finisher-pr" && t.number === pr
          && (!latestFinisher || (t.retry ?? "") > (latestFinisher.retry ?? ""))) {
          latestFinisher = t;
          st.pastPinHalt = members.get(t.name).outcome === "halted:past-pin";
        }
        continue;
      }
      if (tok.startsWith("review=")) {
        const m = REVIEW.exec(tok);
        if (!m && lenient) {
          malformed.add(i);
          st.inFlight = true;
          st.reviewedAny = true;
          continue;
        }
        if (!m) throw new LedgerError(`${where}: '${tok}' is not review=wf:<runId> | member:review-pr-<n>, optionally =failed`);
        st.inFlight = !m.groups.failed;
        if (!m.groups.failed) st.reviewedAny = true;
      } else if (tok.startsWith("reviewed=")) {
        const m = REVIEWED.exec(tok);
        if (!m && lenient) {
          malformed.add(i);
          latestFinisher = null;
          Object.assign(st, { inFlight: false, reviewedAny: true, reviewFixed: false, pastPinHalt: false });
          continue;
        }
        if (!m && REVIEWED_RUNLESS.test(tok)) {
          throw new LedgerError(`${where}: '${tok}' names no review run — reviewed= is now <head>:<survived>/<refuted>/<unverified>:<run>, `
            + "<run> the run-XXXXXXXX directory holding that review's review.json; drop the token with `ledger.mjs row` and record it again with `ledger.mjs review <pr>`");
        }
        if (!m) throw new LedgerError(`${where}: '${tok}' is not reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`);
        latestFinisher = null;
        Object.assign(st, {
          inFlight: false, reviewedAny: true, survived: Number(m[2]), unverified: Number(m[4]), reviewFixed: false,
          reviewedHead: m[1].toLowerCase(), reviewedRun: m[5], pastPinHalt: false,
        });
      } else if (labelOffMember(tok) === null) {
        if (!lenient) throw new LedgerError(`${where}: '${tok}' is not label-off=<finisher-pr member> — fix the row with \`ledger.mjs row\``);
        malformed.add(i);
      } else {
        const h = HELD.exec(tok);
        if (h) st.held.push(Number(h[1]));
        // Every park the PR's rows carry: the tick matches each against the
        // PR's current head and body, so a stale one is never cleared here.
        const k = PARKED.exec(tok);
        if (k) st.parked.push({ head: k[1], digest: k[2], reason: parkedReason(k[3]) });
        const c = CONFLICT_HOLD.exec(tok);
        if (c) {
          // Bound to the row's own PR: a hold naming another PR is a
          // misrecorded one, and read on a guess it would either hold the
          // wrong PR or leave this one silently stalled.
          if (Number(c[1]) !== pr) {
            if (!lenient) {
              throw new LedgerError(`${where}: '${tok}' names PR #${c[1]}, but this row is ${pr === null ? "no PR's" : `PR #${pr}'s`} — a conflict hold goes on the held PR's own row`);
            }
            malformed.add(i);
          } else {
            // A fresh hold is unresolved whatever settled before it, the way a
            // fresh `reviewed=` resets `reviewFixed` above. A redundant re-hold
            // (merge-bot retrying a PR it has already held) changes
            // nothing a live fix-applier holds off: liveness is not read off
            // token order.
            st.conflictOpen = true;
          }
        }
        const v = TIER_VERDICT.exec(tok);
        if (v) verdicts[v[1]].add(v[2]);
        const d = dispositionsToken(tok);
        if (d && d.member.number === pr) st.dispositions.push(d);
      }
    }
    const premises = premisesOf(text);
    if (premises !== null) {
      // An `excluded` row claims its ticket only while its
      // premise still holds. Lifted here only when EVERY premise is a
      // verifiable, now-closed `behind-pr:#M` — the same rule a
      // `held-behind` merge hold uses — since a mixed or `behind-issue`
      // premise needs a live gh probe this pure half cannot make;
      // unclaimed() covers that case once the refreshed shortlist re-admits
      // the ticket.
      const prLifted = premises.length > 0
        && premises.every(({ kind, target }) => kind === "pr" && isDigits(target) && !open.has(Number(target)));
      if (!prLifted) claimed.add(keyNum);
      excluded.push({ n: keyNum, premises });
    }
    if (pr !== null) byPr.set(pr, st);
  }
  return { members, byPr, verdicts, claimed, excluded, malformed };
}

// A PR whose latest finisher halted `past-pin` against a returned review owes
// a fresh one while its head is still past what that review read: a
// `reviewed=` head (7-40 hex) prefix-matching gh's full headRefOid is the head
// that review read, and there is nothing more to review. `st` is a `byPr`
// state, `undefined` for a PR no row names.
export const pastPinDue = (st, head) => st !== undefined && st.pastPinHalt && !st.inFlight && st.reviewedHead !== null
  && !String(head).toLowerCase().startsWith(st.reviewedHead);

// The states a PR-state probe answers: anything else is no answer.
const PR_STATES = ["OPEN", "MERGED", "CLOSED"];

export function deriveRun({ rows, dispatched, drain, retired = [] }, prs, closed = new Set(), prStates = new Map()) {
  const open = new Set(prs.map((p) => p.number));
  const { members, byPr, verdicts, claimed, excluded } = foldLedger({ rows, dispatched }, open);
  // `## Retired` lines as every reader reads them: a line's name before its
  // first `=`. One naming no member or reviewer would leave the name it was
  // meant to hold unaccounted for, so it is refused, as a `## Dispatched`
  // entry that is no member token is.
  const { names: retiredNames, malformed: badRetired } = readRetired(retired);
  if (badRetired.length > 0) {
    throw new LedgerError(`## Retired line '${badRetired[0]}' names no member or reviewer — fix the ledger by hand before the tick can count from it`);
  }

  const all = [...members.values()];
  const live = (family) => all.filter((m) => m.family === family && m.outcome === null).length;
  const impls = all.filter((m) => m.family === "impl");
  for (const m of impls) claimed.add(m.number);
  // Only the LATEST member for a ticket counts. A mismatch is fixed by
  // dispatching a replacement (`impl-N-b`) at the right tier; until that
  // replacement's own check passes, the row holds — a replacement that is
  // ALSO mismatched keeps holding, and one not yet checked holds as
  // unchecked. A member with no verdict at all holds whether it is live or
  // settled — the tick reads no transcript, so only tier-check.mjs can judge
  // one; a settled member whose transcript was never written gets
  // `tier-unverifiable=` from it, which clears the hold here.
  const newest = impls.filter((m, i) => !impls.some((o, j) => j > i && o.number === m.number));
  // A mismatch on a ticket whose issue is CLOSED holds nothing: there
  // is nothing left for `impl-<N>-b` to replace, and a retired definition can
  // never re-check. `closed` is the ticket numbers the caller has probed; the
  // pure fold cannot probe, so none is the default and every mismatch holds.
  // A still-open ticket keeps its hold.
  const mismatched = (m) => m.outcome === "tier-mismatch" || verdicts.mismatch.has(m.name);
  const tierMismatch = newest.filter((m) => mismatched(m) && !closed.has(m.number)).map((m) => m.name);
  // A ticket whose PR closed unmerged. Each ticket is keyed on its LATEST impl
  // member settled `PR#<M>`, walked the way `newest` is — never on rowPr(),
  // which stays first-wins for the per-PR fold — and left alone while an impl
  // member after that one is live (a replacement is running) or once one
  // after it settled `released` (the claim was released). A later `bailed`,
  // `blocked` or `killed` leaves the key on M. So does a later
  // `tier-mismatch`, but the ticket says nothing while the implementer row
  // holds on that mismatch: the row owes the replacement at its tier — the
  // maintainer's `replace` carried on — and holds every Pull until it is
  // dispatched, so a line saying to dispatch nothing for the ticket would
  // stall it. Once that replacement settles the walk reads it like any other.
  // A mismatch on the keyed member itself is no replacement of M and still
  // prints. A keyed PR the open list carries is normal flow; one it does not
  // is named in `prKeyed` for the caller's state probe, `prStates` its
  // answers (none for a PR whose probe could not answer, as by default).
  // CLOSED escalates, an unanswered probe escalates as unchecked, OPEN and
  // MERGED say nothing, and a ticket whose issue the caller found CLOSED
  // (`closed`) says nothing either way.
  const settledPr = (m) => (m.outcome?.startsWith("PR#") ? Number(m.outcome.slice("PR#".length)) : null);
  const supersedes = (o) => settledPr(o) !== null || o.outcome === null || o.outcome === "released";
  const latestPr = impls.filter((m, i) => settledPr(m) !== null
    && !impls.some((o, j) => j > i && o.number === m.number && supersedes(o)));
  const keyed = new Set(latestPr.map((m) => m.name));
  const replacementHeld = new Set(newest.filter((m) => tierMismatch.includes(m.name) && !keyed.has(m.name)).map((m) => m.number));
  const prKeyed = latestPr.filter((m) => !replacementHeld.has(m.number)).map((m) => ({ n: m.number, pr: settledPr(m) }))
    .filter((k) => !open.has(k.pr)).sort((a, b) => a.n - b.n);
  const prSurfaced = prKeyed.filter((k) => !closed.has(k.n));
  // Who on PR M is live: an unsettled fix-applier or finisher bound to it, and
  // a live merge bot when M's latest finisher attempt settled `labelled` with
  // no `label-off=` after it — the ledger's reading of M in the merge queue.
  const queuedOnLedger = new Set(latestFinisherAttempts({ rows, dispatched }, new Set(prSurfaced.map((k) => k.pr)))
    .filter((u) => u.outcome === "labelled").map((u) => u.pr));
  const liveOn = (pr) => all.filter((m) => m.outcome === null
    && (((m.family === "fix-pr" || m.family === "finisher-pr") && m.number === pr) || (m.family === "merge-bot" && queuedOnLedger.has(pr))))
    .map((m) => m.name).sort();
  const cleared = (m) => verdicts.ok.has(m.name) || verdicts.unverifiable.has(m.name);
  const tierUnchecked = newest.filter((m) => !mismatched(m) && !cleared(m)).map((m) => m.name);
  // The In-flight count: tickets between a Claim and their PR's merge. Read off
  // the ledger and `prs` on every tick, never the Phase-0 fold. One term per
  // open PR that closes an issue (GitHub's linked set; a PR closing nothing is
  // never in flight, however it was made), plus one per claimed ticket whose
  // newest impl member is live, or owes a replacement — settled `killed` or
  // `tier-mismatch` on an issue not probed CLOSED — and that no open PR closes
  // yet. A PR absorbs its ticket, so the hand-off from implementer to PR counts
  // once; a ticket counts once however many members it has had. A member
  // settled `blocked`, `bailed`, `released` or `PR#M` counts nothing on its
  // own account, and neither does an Exclusion row, which is no member.
  const prsIn = prs.filter((p) => p.closingIssuesReferences.length > 0);
  const closing = new Set(prsIn.flatMap((p) => p.closingIssuesReferences.map((r) => r.number)));
  const owesReplacement = (m) => (m.outcome === "killed" || m.outcome === "tier-mismatch") && !closing.has(m.number);
  const owedReplacement = newest.filter(owesReplacement).map((m) => m.name);
  const owedCounted = newest.filter((m) => owesReplacement(m) && !closed.has(m.number)).map((m) => m.name);
  const inFlightImpl = newest.filter((m) => m.outcome === null && !closing.has(m.number)).length + owedCounted.length;
  const isQueued = (p) => p.labels.some((l) => l && l.name === "ready-to-merge");
  const queued = prs.filter(isQueued);
  const asc = (a, b) => a - b;
  const state = (n) => byPr.get(n);
  const heldBehind = (st) => (st?.held ?? []).some((n) => open.has(n));
  const conflictHeld = (st) => st !== undefined && st.conflictOpen;
  const mergeHeldOn = (p) => heldBehind(state(p.number)) || conflictHeld(state(p.number));
  // The latest park on a queued PR whose head and body still match it, or
  // undefined: a new head or an edited body lifts every earlier park.
  const parkOn = (p) => {
    const parks = state(p.number)?.parked ?? [];
    if (parks.length === 0) return undefined;
    const digest = bodyDigest(p.body);
    return parks.findLast((k) => k.head === p.headRefOid.toLowerCase() && k.digest === digest);
  };
  const anyLive = (names) => [...names].some((n) => members.get(n).outcome === null);
  const fixRunning = (st) => anyLive(st.fixMembers);
  // An open PR the ledger tracks that GitHub reads CONFLICTING — no other
  // `mergeable` value: UNKNOWN is read again next tick, and a PR merely behind
  // is the merge bot's server-side update — with no hold on record yet and
  // nobody on it who may be pushing. A queued one is the merge bot's while one
  // is live: its own rebase fallback records the hold. A review in flight is no
  // reason to wait, since fixDue already waits for it to return.
  const working = (st) => anyLive(st.workers);
  const mergeBotLive = live("merge-bot");
  const conflicting = prs.filter((p) => p.mergeable === "CONFLICTING" && byPr.has(p.number)
    && !conflictHeld(state(p.number)) && !working(state(p.number)) && !(isQueued(p) && mergeBotLive > 0));
  // Two conflict fix-appliers landed on it, ever, and it conflicts again: a
  // treadmill.
  const treadmill = (p) => state(p.number).conflictLanded.size >= 2;
  // The latest review's dispositions verdict is a mismatch no later fix-applier
  // has answered: the verdict is the highest-suffixed one, and no fix-applier
  // with a higher suffix has landed. A landed one is awaiting its own check, so
  // the earlier mismatch is not its verdict; a failed or killed one answered
  // nothing, and so did a conflict fix-applier, which is never checked. An
  // escalate is a different verdict and is never due.
  const mismatchDue = (st) => {
    const cur = currentDispositions(st.dispositions, st.reviewedRun);
    if (cur === null || cur.verdict !== "mismatch") return false;
    const retry = parseMember(cur.member).retry ?? "";
    return ![...st.fixLanded].some((n) => !st.conflictLanded.has(n) && (parseMember(n).retry ?? "") > retry);
  };
  // A `review=` token with no `reviewed=` after it reads as in flight, and the
  // ledger alone never says otherwise: a review whose own `reviewed=` write
  // never landed stays in flight after its PR merges, counting as a review unit
  // for good. A PR the caller's probe found MERGED or CLOSED (`prStates`) is
  // finished, and a finished PR has no review running against it. A PR on the
  // open list is open whatever the probe says, and none is the default, so a
  // PR nobody has asked about keeps its review live.
  const reviewing = [...byPr.entries()].filter(([, st]) => st.inFlight);
  const finished = (n) => prStates.get(n) === "MERGED" || prStates.get(n) === "CLOSED";
  const liveReviews = reviewing.filter(([n]) => open.has(n) || !finished(n));
  const unsettled = all.filter((m) => m.outcome === null).map((m) => m.name);
  return {
    implLive: live("impl"),
    inFlight: inFlightImpl + prsIn.length,
    inFlightImpl,
    inFlightPrs: prsIn.length,
    owedReplacement,
    owedCounted,
    // Each ticket's keyed PR the open list does not carry, `{n, pr}` ascending
    // by ticket: the PRs the caller probes the state of.
    prKeyed,
    // The tickets whose keyed PR the probe read CLOSED, each with `live`, the
    // members on PR M still unsettled; and those whose probe did not answer.
    // Additive lines beside the implementer row: neither counts toward
    // anything above.
    prClosed: prSurfaced.filter((k) => prStates.get(k.pr) === "CLOSED").map((k) => ({ ...k, live: liveOn(k.pr) })),
    prUnchecked: prSurfaced.filter((k) => !PR_STATES.includes(prStates.get(k.pr))),
    fixLive: live("fix-pr"),
    mergeBotLive,
    // The number of every merge bot settled `done`: each is a merge pass
    // `--apply` reaps and reclaims after, once (reapDue).
    mergeBotDone: all.filter((m) => m.family === "merge-bot" && m.outcome === "done").map((m) => m.number).sort(asc),
    reviewsLive: liveReviews.length,
    // The in-flight reviews of PRs the open list does not carry: the ones
    // the probe could retire, so the caller asks gh about these and no others.
    reviewsOffList: reviewing.filter(([n]) => !open.has(n)).map(([n]) => n).sort(asc),
    // A returned review whose survived or unverified findings no review
    // fix-applier has answered — `ledger.mjs dispatch` refuses a finisher
    // on either until one has — a conflict hold no fix-applier has cleared,
    // or a dispositions mismatch no retry has answered — on a PR still open,
    // with no fix-applier working it and no newer review running. The first
    // two are answered apart here: a landed conflict fix-applier lifts the
    // hold and leaves findings it never read due for a review one.
    fixDue: [...byPr.entries()]
      .filter(([n, st]) => open.has(n)
        && (((st.survived > 0 || st.unverified > 0) && !st.reviewFixed) || conflictHeld(st) || mismatchDue(st))
        && !fixRunning(st) && !st.inFlight)
      .map(([n]) => n).sort(asc),
    // Open, not signed off, closing an issue (GitHub's own linked set — a
    // PR closing nothing is review work nobody in the run will ever be
    // dispatched against), with no live or returned review on record —
    // or a returned review its finisher halted `past-pin` against: the
    // head carries commits no reviewer read, so it is owed a review again
    // until one is running or has returned. A head that moved past
    // `reviewed=` with no such halt — a fix-applier's push — stays not due:
    // finisher duty 2 verifies what it applied.
    reviewDue: prs
      .filter((p) => !isQueued(p) && p.closingIssuesReferences.length > 0
        && (!state(p.number)?.reviewedAny || pastPinDue(state(p.number), p.headRefOid)))
      .map((p) => p.number).sort(asc),
    mergeQueue: queued.length,
    // A `held-behind` hold lifts once its premise PR has left the open list —
    // MERGED or CLOSED, the same lift rule as a `behind-pr` Exclusion. A
    // conflict hold lifts only once a fix-applier after it has SETTLED
    // `applied:`/`no-op` — never on dispatch alone.
    mergeHeld: queued.filter(mergeHeldOn).length,
    // How many of those are conflict holds — the HOLD row's wording, no field.
    mergeConflictHeld: queued.filter((p) => conflictHeld(state(p.number))).length,
    // Each queued PR no hold counts that a park still matches, `{pr, reason}`
    // ascending: the merge bot would only refuse it again.
    mergeParked: queued.flatMap((p) => {
      const k = mergeHeldOn(p) ? undefined : parkOn(p);
      return k === undefined ? [] : [{ pr: p.number, reason: k.reason }];
    }).sort((a, b) => a.pr - b.pr),
    // Finishers settled `labelled` on an open PR without the label.
    unlabelled: unlabelledFinishers({ rows, dispatched },
      new Set(prs.filter((p) => !isQueued(p)).map((p) => p.number))),
    // Every PR, open or not, on a conflict hold no fix-applier has cleared —
    // the one reading of a hold: `ledger.mjs dispatch` refuses a finisher off
    // this list, so it
    // answers the same per-PR fold this tick holds the merge on, split rows
    // and a settle made anywhere included, rather than re-deriving it from
    // one row's text.
    conflictHeld: [...byPr.entries()].filter(([, st]) => conflictHeld(st)).map(([n]) => n).sort(asc),
    // Each `conflicting` PR: a hold for the controller to record, or — past
    // two landed conflict fix-appliers — a PR for a human.
    conflicts: conflicting.filter((p) => !treadmill(p)).map((p) => p.number).sort(asc),
    conflictEscalate: conflicting.filter(treadmill).map((p) => p.number).sort(asc),
    // Every PR, open or not, with a returned review: its latest `reviewed=`
    // head, run and counts, the dispositions verdict currently answering that
    // run, and every fix-applier on the PR still unsettled (`fixLive`) — a
    // re-review would otherwise read the earlier
    // fix-applier's verdict while the one answering it is still working.
    // `ledger.mjs dispatch` gates a finisher off this, read from the same
    // per-PR fold as everything above, and dispositions-check.mjs reads the
    // review file it judges against off `run`. Nothing in this tick acts on it.
    reviewed: [...byPr.entries()].filter(([, st]) => st.reviewedHead !== null)
      .map(([n, st]) => ({
        pr: n, head: st.reviewedHead, run: st.reviewedRun, survived: st.survived, unverified: st.unverified,
        dispositions: currentDispositions(st.dispositions, st.reviewedRun),
        fixLive: [...st.fixMembers].filter((name) => members.get(name).outcome === null).sort(),
      }))
      .sort((a, b) => a.pr - b.pr),
    draining: drain ?? null,
    tierMismatch,
    // Every impl member the ledger names, settled or live: the retry letters
    // a mismatch's replacement must climb past (replaceStep).
    implNames: impls.map((m) => m.name),
    tierUnchecked,
    claimed,
    excluded,
    // Who is live, by name, for a MAIN-CHECKOUT line: every unsettled
    // member token, then each in-flight review by its PR — a `review=wf:`
    // run carries no member token of its own.
    live: [
      ...unsettled,
      ...liveReviews.map(([n]) => `review:PR#${n}`),
    ],
    // Who may have a report file on disk, by the name it is filed under: every
    // unsettled member token. A review runner has no report schema and a
    // `review=wf:` run no member, so neither files one.
    reporters: unsettled,
    // Every member name the ledger records, settled or live: each row's
    // member tokens, each `## Dispatched` entry and each `## Retired` line's
    // name — the names a transcript in the session directory is accounted for by.
    recorded: new Set([...members.keys(), ...retiredNames]),
  };
}

// The shortlist entries no `impl-` or `excluded` row has claimed, in the
// file's own oldest-first order. A `behind-pr:#M` exclusion is trusted from
// `run.claimed` alone — `open` is read fresh every tick, so there is nothing
// stale to defer to. An exclusion deriveRun cannot verify purely (a
// `behind-issue` or branch-named premise) is different: its row is rewritten
// only when a Pull dispatches the ticket (shortlist.mjs's own header, §3),
// never on its own, so once shortlist.mjs's live probe has re-admitted the
// ticket to these entries, that stale row no longer blocks it. A row naming no
// premise has nothing to lift: it claims its ticket for good, as `pull.mjs
// next` and shortlist.mjs read it.
export function unclaimed(entries, run) {
  const unverifiable = new Set(run.excluded
    .filter((e) => e.premises.length > 0 && e.premises.every(({ kind, target }) => kind !== "pr" || !isDigits(target)))
    .map((e) => e.n));
  return entries.map((e) => e.n).filter((n) => !run.claimed.has(n) || unverifiable.has(n));
}

// shortlist.mjs's payload, `{scanned, shortlist: [{n, t}], dropped: [{n,
// reason}]}`, or unparsable. A payload with no `dropped` predates the field
// and reads as no drops.
export function parseShortlist(text) {
  const none = { status: "unparsable", scanned: null, entries: [], dropped: [] };
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    return none;
  }
  if (!d || typeof d !== "object" || !Number.isInteger(d.scanned) || d.scanned < 0 || !Array.isArray(d.shortlist)
    || !d.shortlist.every((e) => e && Number.isInteger(e.n) && e.n > 0 && typeof e.t === "string")) return none;
  const dropped = d.dropped === undefined ? [] : d.dropped;
  if (!Array.isArray(dropped) || !dropped.every((e) => e && Number.isInteger(e.n) && e.n > 0 && typeof e.reason === "string")) return none;
  return {
    status: "ok", scanned: d.scanned, entries: d.shortlist.map(({ n, t }) => ({ n, t })),
    dropped: dropped.map(({ n, reason }) => ({ n, reason })),
  };
}

// Why this tick refreshes the shortlist, or null. `unclaimed` counts the
// heads a PULL row could name, so a head whose Pull ended in this run is not
// in it — a Pull that left on an Exclusion is no such end (pullOf). The
// premise-lifted trigger costs gh calls, so main() asks it only when these
// answer null.
// Nothing refreshes while the bound holds (`held`, n ≥ B, whichever HOLD row
// prints): a refresh then cannot feed a Pull, and the first tick back under
// the bound refreshes and Pulls in the same tick, so nothing is lost.
export function refreshWhy({ draining, held, status, entries, unclaimed: k, bound }) {
  if (draining !== null || held) return null;
  if (status !== "ok") return `shortlist ${status}`;
  if (entries === 0) return "shortlist empty";
  if (k < bound) return shortQueue(k, bound);
  return null;
}

// The short-queue trigger's text, the one trigger that names a count.
function shortQueue(k, bound) {
  return `unclaimed ${k} < in-flight bound ${bound}`;
}

// How long, in minutes, a live token of each family may run before the tick
// asks the controller to look at it. Each default is that family's p99
// run time: a token past it is rare among members that finished, so a line
// is worth a look and not noise. Measured 2026-10-11. The four member
// families are the maintainer's reading of the omp rows of
// member-outcomes.tsv, one family each; `review` is
// the nearest-rank p99 of (last - first entry timestamp) over every
// review-pr-*.jsonl under ~/.omp/agent/sessions — 77.09 min over 4751
// transcripts, rounded up. Re-derive by re-running that query; no script
// carries it.
export const LIVENESS_DEFAULTS = { impl: 78, "fix-pr": 56, "finisher-pr": 57, "merge-bot": 101, review: 78 };
// One flag per family, so a controller can tune what the defaults get wrong.
const LIVENESS_FLAGS = {
  impl: "liveness-impl", "fix-pr": "liveness-fix-pr", "finisher-pr": "liveness-finisher",
  "merge-bot": "liveness-merge-bot", review: "liveness-review",
};

// A live name's family: a member token's own, or `review` for the in-flight
// `review:PR#<n>` a `review=` launch is named by (it carries no member token).
const livenessFamily = (name) => (name.startsWith("review:") ? "review" : parseMember(name)?.family ?? null);

// The `seen` map for this tick: one stamp per live name, carried when it can
// be trusted and `now` when not. A stamp is the age of the token, so the rule
// is which ones still describe THIS run's token:
//   - an `ancestor` rotate carried this run's tokens across — they are old, and
//     their age must survive it;
//   - `dead` and `none` carry nothing, so a stamp older than the record's `at`
//     belongs to a token of the previous run, even one that shares its name
//     (`merge-bot-1` is reused), and restarts at zero;
//   - no record, or one with no `at`, leaves nothing to compare, so the stamp
//     stands.
// A name that is no longer live is dropped: a settled member's stamp must not
// age a later token of the same name.
export function stampSeen({ live, prev, controller, now }) {
  const thisRun = (at) => controller === null || controller.prior === "ancestor" || controller.at === null || at >= controller.at;
  const next = {};
  for (const name of live) next[name] = prev[name] !== undefined && thisRun(prev[name]) ? prev[name] : now;
  return next;
}

// The CHECK-LIVENESS lines: one per live name past its family's threshold, as
// `{member, line}`. The age shows only as a multiple of the threshold, so the
// line — and the digest `--fold-unchanged` compares — changes when a member
// crosses into the next bucket and never on the minute between.
export function livenessLines({ live, seen, thresholds, now }) {
  const out = [];
  for (const member of live) {
    const family = livenessFamily(member);
    if (family === null || seen[member] === undefined) continue;
    const minutes = thresholds[family];
    const k = Math.floor(Math.max(0, now - seen[member]) / (minutes * 60_000));
    if (k < 1) continue;
    const label = family === "finisher-pr" ? "finisher" : family;
    out.push({ member, line: `CHECK-LIVENESS ${member} (${label} > ${k === 1 ? "" : `${k}×`}p99 ${k * minutes}m)` });
  }
  return out;
}

// The report lines: one per name in `reporters` with a report file on disk, as
// `{member, settle, line, key}`, and `invalid: true` on a REPORT-INVALID one.
// `reports` maps a name to what main() read off its file — `{path, since,
// member, violation}`, `since` the file's mtime in ms, `member` the file's own
// `member` field (undefined when it has none or is not JSON) and `violation`
// the first violation of the schema of the name's family (undefined when the
// file validates, or when no schema covers the name) — or `{path, unreadable}`,
// `unreadable` the error code of a file that is there and cannot be read — and
// has no entry for a name with no file. A file that names a member other than
// the one it is filed under prints REPORT-MISMATCH instead, once, an
// unreadable one REPORT-UNREADABLE, and one that names its member and fails
// its schema REPORT-INVALID; for all three `settle` is false. `reportsFrom`,
// when set, is the directory the printed settle reads its file from:
// ledger.mjs reads the default scratch root's `reports/` unless told
// otherwise. `key` is the line without its age, what the digest
// `--fold-unchanged` compares takes, so a report waiting on disk folds rather
// than moving the digest every minute.
export function reportLines({ reporters, reports, now, reportsFrom = null }) {
  const out = [];
  const from = reportsFrom === null ? "" : ` --reports ${/^[\w./@%+=:,-]+$/.test(reportsFrom) ? reportsFrom : `'${reportsFrom.replaceAll("'", "'\\''")}'`}`;
  for (const member of new Set(reporters)) {
    const r = reports.get(member);
    if (r === undefined) continue;
    if (r.unreadable !== undefined) {
      const line = `REPORT-UNREADABLE ${r.path} (${r.unreadable})`;
      out.push({ member, settle: false, line, key: line });
      continue;
    }
    if (r.member !== member) {
      const named = typeof r.member === "string" ? r.member : JSON.stringify(r.member) ?? "none";
      const line = `REPORT-MISMATCH ${r.path} (member: ${named})`;
      out.push({ member, settle: false, line, key: line });
      continue;
    }
    if (r.violation !== undefined) {
      const line = `REPORT-INVALID ${r.path} (${r.violation})`;
      out.push({ member, settle: false, invalid: true, line, key: line });
      continue;
    }
    const age = Math.floor(Math.max(0, now - r.since) / 60_000);
    out.push({
      member, settle: true, key: `SETTLE ${member}`,
      line: `SETTLE ${member} (report on disk since ${age}m — ledger.mjs settle ${member} --from-report${from})`,
    });
  }
  return out;
}

// The stems of the `<stem>.jsonl` names in a session directory's listing,
// sorted: the listing's own order is the filesystem's.
export const transcriptStems = (names) => names.filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -".jsonl".length)).sort();

// The UNRECORDED lines: one per stem in `stems` that is a member name
// (parseMember's, any family, retry letters included) and that `recorded`
// — deriveRun's every name on the ledger — lacks, as `{kind, name, line, key}`. A
// transcript is a dispatch the ledger never recorded, so the next tick would
// name that dispatch again. A stem that is no member's name (a reviewer
// runner's, `agent-abc123`) is never one. Advice: nothing here writes
// the ledger.
export function unrecordedLines({ stems, recorded }) {
  return stems.filter((stem) => parseMember(stem) !== null && !recorded.has(stem)).map((name) => {
    const line = `UNRECORDED ${name} (transcript exists, no ledger token)`;
    return { kind: "UNRECORDED", name, line, key: line };
  });
}

// The `--no-transcript-after` default, in minutes: its one definition, which
// fleet-event.mjs's member-died reads as its own no-transcript bound.
export const NO_TRANSCRIPT_AFTER_DEFAULT = 5;

// The NO-TRANSCRIPT lines: one per live member token in `live` whose `seen`
// stamp is more than `after` minutes old and whose `<member>.jsonl` is not
// among `stems`, as `{kind, name, line, key}` — a ledger token whose `task` call
// was never made. A `review:PR#<n>` launch is no member and has no
// transcript named after it, so it is never one. `key` is the line without
// its age, what the digest `--fold-unchanged` compares takes.
export function noTranscriptLines({ live, seen, stems, session, after, now }) {
  const has = new Set(stems);
  const out = [];
  for (const name of live) {
    if (parseMember(name) === null || seen[name] === undefined || has.has(name)) continue;
    const ms = now - seen[name];
    if (ms <= after * 60_000) continue;
    out.push({
      kind: "NO-TRANSCRIPT", name, key: `NO-TRANSCRIPT ${name}`,
      line: `NO-TRANSCRIPT ${name} (live ${Math.floor(ms / 60_000)}m, no ${join(session, `${name}.jsonl`)})`,
    });
  }
  return out;
}

// The age-based checks this tick would run: CHECK-LIVENESS on
// a live name of a known family, NO-TRANSCRIPT on a live member token with no
// transcript among `stems` (null when the session was not listed). main()
// names them on stderr when the state file is degraded: its `seen` stamps
// cannot be read, so every token reads as first seen now and neither fires.
export function ageChecks({ live, stems }) {
  const has = new Set(stems);
  return [
    ...(live.some((name) => livenessFamily(name) !== null) ? ["CHECK-LIVENESS"] : []),
    ...(stems !== null && live.some((name) => parseMember(name) !== null && !has.has(name)) ? ["NO-TRANSCRIPT"] : []),
  ];
}

// --apply's pure half. The merge-bot numbers `applied.reapAfter` names for
// THIS run: none when its `run` is not the controller record's `at`, since
// merge-bot numbering restarts with a run and the state file outlives it
// (fleet-state.mjs's `applied`). `controllerAt` is null with no record, and
// with no record nothing tells this run from the one before it: a list then
// names nothing, and the sweeps run again on the next tick.
export function reapedAfter(applied, controllerAt) {
  return applied !== null && controllerAt != null && applied.run === controllerAt ? applied.reapAfter : [];
}

// The merge passes owed their reap and reclaim: every merge bot settled
// `done` that reapedAfter() does not name.
export function reapDue(done, applied, controllerAt) {
  const ran = new Set(reapedAfter(applied, controllerAt));
  return done.filter((n) => !ran.has(n));
}

// The implementers the tick would print `HOLD (tier unchecked …)` for: read
// off the rows reconcile() computed, so whatever outranks that hold — the
// drain, a mismatch, phase 0, the main checkout — outranks the check too.
export function tierCheckDue(rows, unchecked) {
  return rows.some((r) => r.role === "implementers" && r.action.startsWith("HOLD (tier unchecked ")) ? unchecked : [];
}

// The one JSON line a receipt-printing script ends on, or null.
function receiptOf(stdout) {
  try {
    const r = JSON.parse(String(stdout).trim().split("\n").at(-1));
    return r !== null && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

// reap.sh's receipt as `reaped <k>, kept <m>, worktreesRemoved <w>`, or null
// for a stdout that carries none. A receipt with warnings adds `warnings
// <n>: <first note>`: reap.sh exits 0 with them, and this line is the only
// place an unattended tick can say so.
export function reapSummary(stdout) {
  const r = receiptOf(stdout);
  if (r === null || ![r.reaped, r.kept, r.worktreesRemoved].every(Array.isArray)) return null;
  const warned = Array.isArray(r.warnings) ? r.warnings : [];
  const first = warned[0]?.note;
  return `reaped ${r.reaped.length}, kept ${r.kept.length}, worktreesRemoved ${r.worktreesRemoved.length}`
    + (warned.length ? `, warnings ${warned.length}${typeof first === "string" ? `: ${first}` : ""}` : "");
}

// reclaim-scratch.mjs's receipt as `removed <k>, kept <m>, failed <f>`, or
// null. A removal that failed is in the receipt and exits 0: it is reported
// here, and the pass still counts as reclaimed after.
export function reclaimSummary(stdout) {
  const r = receiptOf(stdout);
  if (r === null || ![r.removed, r.kept, r.failed].every(Array.isArray)) return null;
  return `removed ${r.removed.length}, kept ${r.kept.length}, failed ${r.failed.length}`;
}

// --------------------------------------------------------------------------
// I/O. Everything below runs only as a CLI — importing this file must never
// parse argv or touch the network, or the pure half stops being unit-testable.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCLI } from "./is-cli.mjs";
import { parseArgs } from "node:util";
import { makeDie, isDigits } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { ghAliasedRead } from "./gh-aliased-read.mjs";
import { fleetFile, FleetDirUnresolvable, scratchRoot } from "./fleet-dir.mjs";
import { statePath, readState, writeState, assessBeat, isStalled, isReported, stallReport, stallOwner } from "./fleet-state.mjs";
import { checkMainCheckout, describe } from "./main-checkout.mjs";
import { readRunReceipt, phase0Gate, IN_FLIGHT_DEFAULT } from "./phase0-receipt.mjs";
import { judgeRecord, ProcUnreadable } from "./proc.mjs";
import { reportFamily, readReport, reportPath, reportsDir } from "./report-files.mjs";
import { ownClosingIssues } from "./closing-refs.mjs";

const NAME = "fleet-tick";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// Open PRs read per tick. At exactly this many the list may be truncated and
// nothing in the result says so, so it refuses — "no silent caps", same rule
// candidates.mjs enforces on its own query.
const PR_LIMIT = 200;
// GitHub's `mergeable` values. One outside them is a drifted enum, refused
// rather than read as not conflicting.
const MERGEABLE_STATES = ["MERGEABLE", "CONFLICTING", "UNKNOWN"];
// Claimed tickets read per stall report. Same "no silent caps" rule as
// PR_LIMIT above, resolved the other way: the read below cannot REFUSE at the
// cap, because refusing would suppress the one announcement a dead run leaves
// behind. So it discloses instead — the line says the count is a floor.
const CLAIMED_LIMIT = 200;
// The tick's last line once a draining run has nothing left in flight. The
// tick cannot write the stop — `beat` is fleet-heartbeat's — so it names it.
export const RUN_OVER = `ACTION: run over → fleet-heartbeat.mjs --stop "<reason>"`;
const MAX_BUFFER = 64 * 1024 * 1024;
// Every gh spawn below is killed at this bound, so a gh that never answers is
// a failed read on that call's own failure path — the open-PR read refuses the
// tick, a probe leaves standing what it could not confirm, the claimed count
// reads unknown — never a tick that does not return. The bound is per gh call,
// not per tick: the probes run one after another, so a tick whose probes all
// hang waits one bound for each of them. 20 s, shortlist.mjs's own gh bound.
// FLEET_TICK_GH_TIMEOUT overrides it, in seconds, and can only ever
// SHORTEN it — ledger.mjs's LEDGER_GIT_TIMEOUT rule: a value that is not a
// positive whole number below the default leaves the default standing, in
// silence. Exported for its own test; it touches nothing.
export function ghBudget(defaultSeconds, override) {
  const seconds = isDigits(String(override)) ? Number(override) : 0;
  return (seconds > 0 && seconds < defaultSeconds ? seconds : defaultSeconds) * 1000;
}
const GH_TIMEOUT_MS = ghBudget(20, process.env.FLEET_TICK_GH_TIMEOUT);
const TIMED_OUT = `timed out after ${GH_TIMEOUT_MS / 1000}s`;

// die() shared with the other fleet scripts (writeSync-based, pipe-safe —
// see arg.mjs for the rationale). This file parses its own
// options with node:util's parseArgs rather than arg()/has(), so die() and
// the isDigits() rule int() calls are all it shares.
const die = makeDie(NAME);

// Every input the controller used to state is read off the run now, so what
// is left is configuration, and all of it defaults.
const OPTIONS = {
  // The In-flight bound: the most tickets between Claim and merge at once. The
  // default is phase0-receipt.mjs's, the one phase 0 also takes, declared this
  // way so it still goes through the guard below, where a hand-passed default
  // went round it.
  "in-flight": { type: "string", default: String(IN_FLIGHT_DEFAULT) },
  // `--fold-unchanged` prints ONE line instead of the rows when this tick asks
  // for nothing and says exactly what the last one said — what makes an
  // unattended night affordable. Opt-in because folding is wrong on an edge:
  // a controller that just acted needs the full rows.
  "fold-unchanged": { type: "boolean", default: false },
  // `--apply` runs the idempotent follow-ups whose trigger the ledger and the
  // state file show, before the rows: reap.sh and reclaim-scratch.mjs after
  // every merge pass settled `done`, and tier-check.mjs on every implementer
  // the tick would hold as unchecked. It never dispatches, never settles a
  // member and writes no ledger row but through those scripts. Without it the
  // tick is read-only.
  apply: { type: "boolean", default: false },
  // Path override, for tests. An empty value cannot be told from an absent one
  // under parseArgs, and no path is legitimately empty, so empty resolves to
  // the default.
  state: { type: "string", default: "" },
  // The scratch root the report files are under, for a run whose phase-0
  // receipt names none; the receipt's `scratch` wins when it does. Empty is
  // absent, as with --state.
  scratch: { type: "string", default: "" },
  // The session directory the transcript listing is read off, for a run whose
  // phase-0 receipt names none; the receipt's `session` wins when it does.
  // Empty is absent, as with --state.
  session: { type: "string", default: "" },
  // Minutes a live member token may go with no transcript in the session
  // directory before NO-TRANSCRIPT names it.
  "no-transcript-after": { type: "string", default: String(NO_TRANSCRIPT_AFTER_DEFAULT) },
  // Minutes a Pull's question may stand, its `pull.json` unwritten, before the
  // PULL row naming it says `(stale)`.
  "pull-stale-minutes": { type: "string", default: "120" },
  // Minutes a live token of each family may run before CHECK-LIVENESS names it.
  ...Object.fromEntries(Object.entries(LIVENESS_FLAGS).map(([family, flag]) => [flag, { type: "string", default: String(LIVENESS_DEFAULTS[family]) }])),
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
    // The digits rule, called rather than restated. Digits, not
    // Number(): `Number("")` is 0, so `--in-flight ""` — the shape an unset
    // shell variable produces — would otherwise read as a real number.
    if (!isDigits(String(raw).trim())) die(`--${name} must be a non-negative integer, got '${raw}'`);
    return Number(raw);
  };
  const positive = (name) => {
    const n = int(name);
    if (n < 1) die(`--${name} must be at least 1, got ${n}`);
    return n;
  };
  return {
    bound: positive("in-flight"),
    fold: values["fold-unchanged"], apply: values.apply, state: values.state || statePath(NAME), scratch: values.scratch,
    session: values.session || null, noTranscriptAfter: positive("no-transcript-after"), pullStaleMinutes: positive("pull-stale-minutes"),
    liveness: Object.fromEntries(Object.entries(LIVENESS_FLAGS).map(([family, flag]) => [family, positive(flag)])),
  };
}

// The open PRs, validated, each with its closingIssuesReferences reduced to
// `{number}` for every issue it closes in its own repository, by
// ownClosingIssues()'s rule: another repository's reference, whatever its
// number, closes none of this repository's tickets. A failed read is not an
// empty pipeline: backlog 0 + merge-queue 0 is a plausible tick, so printing
// it off a failed query is the silent stall this script exists to end.
const PR_ROW_SHAPE = "{number,labels,closingIssuesReferences[{number,url|repository{name,owner{login}}}],headRefOid,mergeable,body,url} rows, url ending /pull/<number>, mergeable one of MERGEABLE, CONFLICTING, UNKNOWN";
function openPrs() {
  let out;
  try {
    out = execFileSync("gh", ["pr", "list", "--state", "open", "--limit", String(PR_LIMIT),
      "--json", "number,labels,closingIssuesReferences,headRefOid,mergeable,body,url"], { encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: GH_TIMEOUT_MS });
  } catch (e) {
    // Never interpolates e.stderr or e.message: execFileSync already forwarded
    // the child's stderr to ours, and Node builds e.message out of it, so
    // either one emits every byte a second time.
    die(`gh pr list failed: ${e.code === "ETIMEDOUT" ? TIMED_OUT : e.code ?? (e.signal ? `killed by ${e.signal}` : `exit ${e.status}`)} — a failed read is not an empty queue`);
  }
  let prs;
  try {
    prs = JSON.parse(out);
  } catch (e) {
    die(`could not parse gh pr list output as JSON: ${e.message}`);
  }
  // closingIssuesReferences is checked, not defaulted: absent, it would read as
  // an empty list and drop every open PR from review work — and from the
  // In-flight count. Each reference must be readable by ownClosingIssues():
  // the count matches a PR to the ticket it closes by its number, and a
  // reference that cannot be placed would leave that ticket's implementer
  // counted twice, or count another repository's issue as this one's. url is
  // required too: the PR's own repository, which that rule places each
  // reference against, is its url less /pull/<number>.
  // headRefOid likewise — absent, a `halted:past-pin` PR would read as moved
  // forever — and mergeable: absent or outside GitHub's MergeableState enum,
  // no PR would ever read CONFLICTING. body too: absent, no park could ever be
  // matched or lifted.
  if (!Array.isArray(prs) || prs.some((p) => !p || typeof p.number !== "number"
    || !Array.isArray(p.labels) || !Array.isArray(p.closingIssuesReferences) || typeof p.url !== "string"
    || typeof p.headRefOid !== "string" || !MERGEABLE_STATES.includes(p.mergeable) || typeof p.body !== "string")) {
    die(`gh pr list did not return ${PR_ROW_SHAPE}`);
  }
  if (prs.length === PR_LIMIT) {
    die(`exactly ${PR_LIMIT} open PRs — the list is capped and may be truncated. Raise PR_LIMIT; a backlog that silently drops PRs is not a reconcile.`);
  }
  return prs.map((p) => {
    try {
      return { ...p, closingIssuesReferences: ownClosingIssues(p.number, p.url, p.closingIssuesReferences).map((number) => ({ number })) };
    } catch (e) {
      die(`gh pr list did not return ${PR_ROW_SHAPE}: PR #${p.number} answered ${e.message}`);
    }
  });
}

// A child that did not exit 0, named with the last line it printed. A gh
// killed at GH_TIMEOUT_MS ran and overran: "did not run" would misstate it.
function failure(r, what) {
  if (r.error?.code === "ETIMEDOUT") return `${what} ${TIMED_OUT}`;
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

// `.fleet/shortlist.json` beside the run's ledger, through fleet-dir.mjs's
// fleetFile(). null when unresolvable — read as a missing shortlist, and the
// refresh then says why it could not run. Announced here first: a missing
// shortlist is also what an empty queue looks like, and "outside a
// repository" is not "no candidates yet". main() calls this once per tick,
// so a workspace that stays unresolvable warns once per tick.
function shortlistPath() {
  try {
    return fleetFile("shortlist.json");
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    console.error(`${NAME}: WARNING ${e.message}; reading the shortlist as missing`);
    return null;
  }
}

function readShortlist(path) {
  if (path === null) return { status: "missing", scanned: null, entries: [], dropped: [] };
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { status: "missing", scanned: null, entries: [], dropped: [] };
    // Distinct from `unparsable`: that label's only other producer is
    // genuinely malformed JSON, and a permissions/filesystem fault reported
    // as a JSON-content fault sends the operator chasing the wrong repair.
    return { status: "unreadable", scanned: null, entries: [], dropped: [], code: e.code ?? null, message: e.message };
  }
  return parseShortlist(text);
}

// A gh state read of one Exclusion premise, scrubbed as shortlist.mjs's
// probeState() is: gh's remote resolution follows GIT_DIR/GIT_WORK_TREE, and
// GH_REPO outranks both. The state it printed, or null when it could not
// answer — a nonzero exit, or exit 0 with a body carrying no state (an HTML
// error page, JSON with no state). Either way the unanswered probe is
// disclosed, not dropped: every other gh call in this file either dies or
// logs its failure, so a bare empty catch here would be the one silent
// exception in a file whose whole design goal is "no silent stall".
function premiseState(noun, target, label) {
  const r = spawnSync("gh", [noun, "view", target, "--json", "state"], { encoding: "utf8", timeout: GH_TIMEOUT_MS, env: gitEnv({ GH_REPO: "" }) });
  if (r.error || r.status !== 0) {
    console.error(`${NAME}: ${failure(r, `gh ${noun} view ${target}`)} — ${label} premise unconfirmed, exclusion stands`);
    return null;
  }
  let st = null;
  try { st = JSON.parse(r.stdout).state; } catch { /* no state: disclosed below */ }
  if (typeof st !== "string") {
    console.error(`${NAME}: gh ${noun} view ${target} printed no state — ${label} premise unconfirmed, exclusion stands`);
    return null;
  }
  return st;
}

// An Exclusion whose premise sends the tick to a refresh. Lifted, for a
// ticket the current file does not already carry (if it does, the refresh
// that lifted it has run): a `behind-pr:#M` reads off the open list already
// in hand; a numeric `behind-issue:#M` costs one `gh issue view`; a
// branch-named `behind-pr` costs one `gh pr view`, whose MERGED or CLOSED
// lifts it — before its PR exists, "no open PR" is not "merged". Standing,
// for a branch-named `behind-pr` or a numeric `behind-issue:#M` whose ticket
// the current file still carries: the file may predate the exclusion, and
// only the refresh's own probe can drop the ticket from it, so any answer
// short of MERGED or CLOSED, an unanswered probe included, asks for that
// refresh. An unanswered probe never lifts an exclusion.
function liftedPremise(excluded, entries, prs) {
  const inFile = new Set(entries.map((e) => e.n));
  const open = new Set(prs.map((p) => p.number));
  for (const { n, premises } of excluded) {
    for (const { kind, target } of premises) {
      if (kind === "pr" && !isDigits(target)) {
        const st = premiseState("pr", target, `behind-pr:#${target}`);
        const lifted = st === "CLOSED" || st === "MERGED";
        if (lifted && !inFile.has(n)) return `behind-pr:#${target} ${st}`;
        if (!lifted && inFile.has(n)) return `behind-pr:#${target} not merged, #${n} still on the shortlist`;
        continue;
      }
      if (kind === "issue" && isDigits(target)) {
        const st = premiseState("issue", target, `behind-issue:#${target}`);
        const lifted = st === "CLOSED" || st === "MERGED";
        if (lifted && !inFile.has(n)) return `behind-issue:#${target} ${st}`;
        if (!lifted && inFile.has(n)) return `behind-issue:#${target} not closed, #${n} still on the shortlist`;
        continue;
      }
      if (inFile.has(n) || !isDigits(target)) continue;
      if (kind === "pr" && !open.has(Number(target))) return `behind-pr:#${target} no longer open`;
    }
  }
  return null;
}

// The tickets whose issue is CLOSED, of those the tick would otherwise keep
// counting, holding on or escalating: every ticket holding the implementer row
// on a tier mismatch, every ticket owed a replacement, and every ticket whose
// keyed PR the state probe read CLOSED or could not read (`surfacing`). One
// live read deriveRun needs to lift a hold, uncount a ticket whose replacement
// has nothing left to replace, and drop a closed-PR line for a ticket that is
// done. One `gh issue view` per ticket, deduped (a tier-mismatch outcome is
// both), and none when nothing is owed. A probe that cannot answer — a nonzero
// exit, or a reply carrying no issue state — is disclosed, and the ticket
// stays counted, its hold stands and its line prints: an unreadable state
// never uncounts.
function closedTickets(mismatched, owed, surfacing) {
  const closed = new Set();
  const mismatchedNumbers = new Set(mismatched.map((name) => parseMember(name).number));
  const owedNumbers = new Set(owed.map((name) => parseMember(name).number));
  const numbers = new Set([...mismatchedNumbers, ...owedNumbers, ...surfacing]);
  for (const number of numbers) {
    const unconfirmed = mismatchedNumbers.has(number)
      ? `tier mismatch on #${number} unconfirmed closed, hold stands`
      : owedNumbers.has(number)
        ? `replacement owed on #${number} unconfirmed closed, ticket stays counted`
        : `#${number} unconfirmed closed, its closed-PR line stands`;
    const r = spawnSync("gh", ["issue", "view", String(number), "--json", "state"], { encoding: "utf8", timeout: GH_TIMEOUT_MS, env: gitEnv({ GH_REPO: "" }) });
    if (r.error || r.status !== 0) {
      console.error(`${NAME}: ${failure(r, `gh issue view ${number}`)} — ${unconfirmed}`);
      continue;
    }
    let st = null;
    try { st = JSON.parse(r.stdout).state; } catch { /* no state: disclosed below */ }
    if (st === "CLOSED") closed.add(number);
    else if (typeof st !== "string") {
      // Exit 0 with a body that is not an issue (an HTML error page, a proxy's
      // text, JSON with no state) is as unanswered as a nonzero exit.
      console.error(`${NAME}: gh issue view ${number} printed no state — ${unconfirmed}`);
    }
  }
  return closed;
}

// The state of each PR the tick asks gh about, one aliased `gh api graphql`
// read per hundred PRs however many readings need them: `reviews`, the PRs
// whose review the ledger reads as in flight yet the open list does not carry,
// and `keyed`, each ticket's keyed PR the open list does not carry (deriveRun's
// `prKeyed`). The answer is OPEN, MERGED or CLOSED. A probe that could not
// answer — a failed call, an alias GitHub errored on or answered with nothing,
// a node carrying no state, a state that is none of the three — leaves its PR
// out of the map and is disclosed, per PR, with what it leaves standing; a
// call killed at GH_TIMEOUT_MS is disclosed with that bound.
function prStates(reviews, keyed) {
  const states = new Map();
  const reviewed = new Set(reviews);
  // Two tickets can be keyed on one PR: each is named, on its one probe.
  const ticketsOf = new Map();
  for (const k of keyed) ticketsOf.set(k.pr, [...(ticketsOf.get(k.pr) ?? []), k.n]);
  const numbers = [...new Set([...reviews, ...ticketsOf.keys()])].sort((a, b) => a - b);
  const read = ghAliasedRead(numbers, { field: "pullRequest", selection: "{state}", timeoutMs: GH_TIMEOUT_MS });
  for (const number of numbers) {
    const r = read.get(number);
    const st = r.node?.state;
    if (PR_STATES.includes(st)) {
      states.set(number, st);
      continue;
    }
    const unconfirmed = [
      ...(reviewed.has(number) ? [`review on PR#${number} unconfirmed finished, its unit stands`] : []),
      ...(ticketsOf.get(number) ?? []).map((n) => `#${n}'s PR#${number} unconfirmed closed, printed as pr-unchecked`),
    ].join("; ");
    const why = r.unreachable === "ETIMEDOUT" ? TIMED_OUT : r.unreachable ?? (r.notFound ? "no such pull request" : "no PR state");
    console.error(`${NAME}: gh api graphql gave no answer for PR#${number} (${why}) — ${unconfirmed}`);
  }
  return states;
}

// shortlist.mjs, run by the tick itself. Its per-ticket stderr is
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

// A sibling script --apply runs, the way refresh() runs shortlist.mjs: stdout
// kept for its receipt, stderr captured so only a failure's last line rides
// along. A `.mjs` runs under this node, reap.sh by its own shebang.
function runSibling(file, args) {
  const opts = { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"] };
  return file.endsWith(".mjs")
    ? spawnSync(process.execPath, [join(SCRIPT_DIR, file), ...args], opts)
    : spawnSync(join(SCRIPT_DIR, file), args, opts);
}

// One duty's line: `APPLIED <label>: <receipt summary>`, or `APPLY FAILED
// <duty>: <why>` for a script that did not exit 0 or printed no receipt.
// True when it applied.
function reportDuty(r, { label, duty, what, summarise }) {
  const ran = !r.error && r.status === 0;
  const summary = ran ? summarise(r.stdout) : null;
  console.log(summary !== null ? `APPLIED ${label}: ${summary}`
    : `APPLY FAILED ${duty}: ${ran ? `${what} printed no receipt` : failure(r, what)}`);
  return summary !== null;
}

// Reap, then reclaim, after the merge passes in `due` — once however many
// there are, since both sweep the whole repository and scratch root rather
// than one pass's share. Reclaim runs whether or not reap did: neither reads
// the other's result. True only when both applied, the one case `due` is
// recorded as reaped after; otherwise the next --apply tick runs both again.
function applyReap(due) {
  const label = `reap after ${due.map((n) => `merge-bot-${n}`).join(" ")}`;
  const reaped = reportDuty(runSibling("reap.sh", ["--apply"]), { label, duty: "reap", what: "reap.sh", summarise: reapSummary });
  let root;
  try {
    root = scratchRoot();
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    console.log(`APPLY FAILED reclaim: ${e.message}`);
    return false;
  }
  const reclaimed = reportDuty(runSibling("reclaim-scratch.mjs", ["--root", root, "--apply"]),
    { label: "reclaim", duty: "reclaim", what: "reclaim-scratch.mjs", summarise: reclaimSummary });
  return reaped && reclaimed;
}

// tier-check.mjs's verdict by its exit status, each one a token the check
// writes on the ledger itself. Exit 2 writes nothing. Exit 1 is the check's
// mismatch and also what node exits with on a throw, so it stands as a
// verdict only once the ledger carries it.
const TIER_VERDICTS = new Map([[0, "tier-ok"], [1, "tier-mismatch"], [3, "tier-unverifiable"]]);

// Whether the ledger holds tier-check.mjs's mismatch for `member`: the token
// on a row, or the member itself settled `tier-mismatch`.
function mismatchOnLedger(member) {
  const { rows, dispatched } = readLedger();
  return [...rows, ...dispatched].some((text) => text.split(/\s+/)
    .some((tok) => tok === `${member}=tier-mismatch` || tok.startsWith(`tier-mismatch=${member}:`)));
}

// tier-check.mjs on each member, a batch of one apiece in a temporary file,
// `session` the phase-0 receipt's — left out when the receipt records none,
// which the check refuses by name. True when any check wrote a verdict, so
// the caller reads the ledger it changed again.
function applyTierChecks(members, session) {
  let wrote = false;
  for (const member of members) {
    const dir = mkdtempSync(join(tmpdir(), "fleet-tick-tier-"));
    let r;
    try {
      const batch = join(dir, "batch.json");
      writeFileSync(batch, JSON.stringify([session === null ? { member } : { member, session }]));
      r = runSibling("tier-check.mjs", ["--batch", batch]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const verdict = r.error ? undefined : TIER_VERDICTS.get(r.status);
    if (verdict !== undefined && (r.status !== 1 || mismatchOnLedger(member))) {
      wrote = true;
      console.log(`APPLIED tier-check ${member}: ${verdict}`);
    } else if (!r.error && r.status === 2) {
      // No verdict — most often a live member with no transcript yet — so
      // the hold stands, and the check's own line says why.
      const last = String(r.stderr ?? "").trim().split("\n").at(-1);
      console.log(`APPLIED tier-check ${member}: no verdict${last ? ` — ${last}` : ""}`);
    } else {
      console.log(`APPLY FAILED tier-check ${member}: ${failure(r, "tier-check.mjs")}`);
    }
  }
  return wrote;
}

// How many tickets a dead run stranded. `in-progress` is the claim label
// claim-ticket.sh adds and candidates.mjs's query EXCLUDES — which is why a
// stranded ticket is invisible to the next run's scans, and why this count is
// the actionable half of the report. null for unknown, never 0: a failed query
// reporting "0 claimed" says the dead run stranded nothing.
function claimed() {
  const r = spawnSync("gh", ["issue", "list", "--label", "in-progress", "--state", "open",
    "--limit", String(CLAIMED_LIMIT), "--json", "number", "--jq", "length"], { encoding: "utf8", timeout: GH_TIMEOUT_MS });
  if (r.error || r.status !== 0) {
    // Disclosed, not dropped: a real gh failure must be distinguishable from
    // the deliberately-undiagnosed case.
    const why = r.error?.code === "ETIMEDOUT" ? `gh ${TIMED_OUT}`
      : r.error ? `gh did not run: ${r.error.code ?? r.error.message}`
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

// What the controller record's process is now, for the phase-0 gate: `none`
// with no record, else judgeRecord()'s answer. A process table that cannot
// be read is `unreadable`, said on stderr under the caller's `name`: a
// controller nobody could judge is not one whose receipt may be taken as
// this run's.
export function controllerState(controller, name = NAME) {
  if (controller === null) return "none";
  try {
    return judgeRecord(controller);
  } catch (e) {
    if (!(e instanceof ProcUnreadable)) throw e;
    console.error(`${name}: WARNING ${e.message} — the recorded controller pid ${controller.pid} cannot be judged, so the phase-0 receipt is held`);
    return "unreadable";
  }
}

// The run off the ledger, with the closed tickets, finished reviews and keyed
// PR states gh says the ledger cannot. A review cannot be running against a
// MERGED or CLOSED PR, so its dangling `review=` token stops counting as a
// review unit; an unread state is never read as finished. The issue probe asks
// only about the tickets whose keyed PR read CLOSED or could not be read: OPEN
// and MERGED print nothing whatever the issue says. A ledger it cannot read
// refuses the tick.
function readRun(prs) {
  try {
    const ledger = readLedger();
    const run = deriveRun(ledger, prs);
    const states = prStates(run.reviewsOffList, run.prKeyed);
    const surfacing = run.prKeyed.filter((k) => states.get(k.pr) !== "OPEN" && states.get(k.pr) !== "MERGED").map((k) => k.n);
    const closed = closedTickets(run.tierMismatch, run.owedReplacement, surfacing);
    return deriveRun(ledger, prs, closed, states);
  } catch (e) {
    if (e instanceof LedgerError) die(e.message);
    throw e;
  }
}

// The scratch root the report files are under, and whether it came from
// `--scratch`: the phase-0 receipt's `scratch`, else `--scratch`, else null —
// no root, no check. `ledger.mjs settle --from-report` reads the root
// scratch-root.mjs prints unless given `--reports`, so a root named by the
// flag is one the printed settle must be told.
function reportsScratch(receipt, flag) {
  const named = receipt.read.state === "ok" ? receipt.read.receipt.scratch : undefined;
  if (typeof named === "string" && named !== "") return { root: named, flagged: false };
  return flag === "" ? null : { root: flag, flagged: true };
}

// The report file of each name in `reporters`, as reportLines() takes them:
// `{path, since, member, violation}` per file on disk, `{path, unreadable}` for
// one that cannot be read, nothing for a name with none. `member` is the file's
// own, and a file that is not JSON carries none. `violation` is report-files's
// verdict on a file that is there for a name a schema covers, set only when
// that verdict is invalid; a name no schema covers is never looked up.
export function readReports(scratch, reporters) {
  const out = new Map();
  for (const member of reporters) {
    const path = reportPath(scratch, member);
    let since, text;
    try {
      since = statSync(path).mtimeMs;
      text = readFileSync(path, "utf8");
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") continue;
      out.set(member, { path, unreadable: e.code ?? "unknown error" });
      continue;
    }
    let named;
    try {
      const d = JSON.parse(text);
      named = d !== null && typeof d === "object" && !Array.isArray(d) ? d.member : undefined;
    } catch {
      named = undefined;
    }
    const entry = { path, since, member: named };
    if (reportFamily(member) !== null) {
      const checked = readReport(scratch, member);
      if (checked.state === "invalid") entry.violation = checked.violation;
    }
    out.set(member, entry);
  }
  return out;
}

// The transcript stems in `session`, off one readdir: no file in it is read.
// The receipt's directory not being there yet holds no transcript, so it lists
// none; a `--session` one that is not there is a path somebody typed, and is
// no such case. One that cannot be listed is null and one stderr line — read
// as empty, it would name every live member NO-TRANSCRIPT.
function listTranscripts(session, { missingIsEmpty }) {
  try {
    return transcriptStems(readdirSync(session));
  } catch (e) {
    if (e.code === "ENOENT" && missingIsEmpty) return [];
    console.error(`${NAME}: transcripts not checked — cannot list ${session} (${e.code ?? e.message})`);
    return null;
  }
}

// Where each head's Pull stands, as pullOf() reads its record, for the heads
// with one. A record that is not there, or cannot be read or parsed, is the
// fresh row: `pull.mjs next` names one it cannot use, in its own words.
function readPulls(scratch, heads, { session, now, staleMinutes }) {
  const out = new Map();
  for (const n of heads) {
    const path = join(scratch, `impl-${n}`, "pull.json");
    let since, record;
    try {
      since = statSync(path).mtimeMs;
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const p = pullOf(record, { session, since, now, staleMinutes });
    if (p !== null) out.set(n, p);
  }
  return out;
}

function main() {
  const { fold, apply, state: path, liveness, scratch: scratchFlag, session: sessionFlag, noTranscriptAfter, pullStaleMinutes, ...caps } = options();
  const listPath = shortlistPath();
  const current = readShortlist(listPath);
  // Beside the shortlist, off the same git probe rather than a second one.
  const router = readCostGuard(listPath === null ? null : join(dirname(listPath), "cost-guard.json"));

  // The PRIOR run's liveness, before anything that can refuse. The gh
  // read and the ledger read below both exit 2 on failure, and a stall
  // announced after them is a stall a gh outage can silence. The supply it
  // reports is the local shortlist file's, which no outage can take away.
  // Whose stall it is comes off the controller record, judged only once
  // there is a stall to name, so a healthy tick reads no process table.
  const priorState = readState(path, NAME);
  const tickedAt = Date.now();
  const { beat, ticked, acted, controller } = priorState;
  const verdict = assessBeat({ beat, ticked, acted, controller, now: tickedAt });
  // `ticked`, fleet-tick's own liveness key, written here and on its own,
  // ahead of the gh and ledger reads that can refuse this tick: a refused
  // tick was still invoked, and a run whose every tick refuses on a gh outage
  // is a run working, not a dead one. Only the usage refusals above leave no
  // mark — they never reached the state file — and a file that exists but
  // could not be read is left as it is, as ledger.mjs's `acted` stamp leaves
  // it: rotate refuses on such a file because a record it may hold cannot be
  // known, and a write here would replace that record with a fresh one.
  // Judged before it is written, so the previous run's end prints on this
  // run's first tick and on no later one.
  if (!priorState.degraded) writeState(path, NAME, priorState, { ticked: { at: tickedAt } });
  if (isReported(verdict)) {
    console.log(stallReport(verdict, isStalled(verdict)
      ? { claimed: claimed(), supply: current.scanned, owner: stallOwner(priorState.controller, NAME) }
      : {}));
  }

  // This run's phase 0, off its receipt: unfinished holds the same rows the
  // main checkout does, and never refuses the tick either. Judged against
  // the controller record this tick started from, and against whether that
  // record's process is still there: a finished receipt of the run before
  // carries the same `at` until this run's rotation writes the next.
  const receipt = readRunReceipt();
  const phase0 = phase0Gate(receipt.read, {
    path: receipt.path, controllerAt: controller?.at, controller: controllerState(controller),
  });
  // The session directory's listing, ahead of every ledger read: a dispatch is
  // written to the ledger before its `task` call makes the transcript, so a
  // stem listed here is on whatever ledger is read after. Listed later, a
  // dispatch landing in between would print UNRECORDED for a token the ledger
  // holds. This run's receipt's `session`, else --session, else no check.
  const session = phase0.session ?? sessionFlag;
  if (session === null) console.error(`${NAME}: transcripts not checked — no session in this run's phase-0 receipt and no --session`);
  const stems = session === null ? null : listTranscripts(session, { missingIsEmpty: phase0.session !== null });

  // Every read happens before anything prints: a partial tick is worse than no
  // tick, because half a reconcile still reads like a reconcile. The APPLIED
  // lines are the exception, printed as each duty runs: they say what was
  // done, which is true whether or not the reconcile after them lands.
  const prs = openPrs();
  let run = readRun(prs);

  // The main checkout against the run's baseline, on every tick — the
  // backstop for what member-write-guard cannot see. Never a refusal of the tick:
  // every answer but `clean` is a hold on the dispatching rows plus one line
  // saying why, so the rest of the run keeps reporting.
  const mainCheckout = checkMainCheckout();

  if (apply) {
    // Reap and reclaim after every merge pass settled `done` since the last
    // time they ran. Recorded only once both applied, on a fresh read of the
    // state file so nothing the heartbeat wrote meanwhile is reverted, never
    // onto a file that could not be read, and never with no controller
    // record: nothing could tell a list recorded then from the next run's.
    const run0 = controller?.at ?? null;
    const due = reapDue(run.mergeBotDone, priorState.applied, run0);
    if (due.length && applyReap(due) && run0 !== null) {
      const now = readState(path, NAME);
      if (!now.degraded) {
        writeState(path, NAME, now, { applied: { run: run0, reapAfter: [...new Set([...reapedAfter(now.applied, run0), ...due])] } });
      }
    }
    // The tier check, on exactly the members the implementer row would hold
    // as unchecked — that row reads the same before the refresh as after it.
    // A verdict written changes the ledger, so the run is read again.
    const unchecked = tierCheckDue(reconcile({
      ...caps, ...run, heads: unclaimed(current.entries, run), supply: current.scanned, dropped: current.dropped,
      shortlistStatus: current.status, refresh: null, mainCheckout, phase0, router,
    }), run.tierUnchecked);
    if (unchecked.length && applyTierChecks(unchecked, phase0.session)) run = readRun(prs);
  }

  // The scratch root of the report files and the Pull records alike.
  const scratch = reportsScratch(receipt, scratchFlag);
  if (scratch === null) console.error(`${NAME}: report files and Pull records not checked — no scratch in the phase-0 receipt and no --scratch`);
  // Each head's Pull record read, not only the heads a free slot names: a head
  // whose Pull ended gives its slot to the next, so the heads past the slots
  // can fill one. A Pull that left on an Exclusion is no such end (pullOf). The
  // session it is judged against is the receipt's, as pull.mjs judges it.
  const runSession = receipt.read.state === "ok" && receipt.read.receipt.session !== "" ? receipt.read.receipt.session : null;
  const pullsOf = (hs) => scratch === null ? new Map()
    : readPulls(scratch.root, hs, { session: runSession, now: Date.now(), staleMinutes: pullStaleMinutes });

  // Pull from the current file first; refresh when it is short, absent, an
  // exclusion has lifted, or a branch-named or issue one still names a ticket on it.
  // A refresh that succeeds replaces the heads outright: the PULL is read off
  // what shortlist.mjs just probed, never merged with the file's own heads,
  // or a ticket the refresh dropped would be pulled anyway.
  let heads = unclaimed(current.entries, run);
  let pulls = pullsOf(heads);
  let supply = current.scanned;
  let dropped = current.dropped;
  let fresh = null;
  // Short means fewer heads than B that a PULL row could name: `pull.mjs next`
  // skips a head whose Pull ended in this run, so counting it would hold back
  // the refresh that finds the head to take its slot. A Pull that left on an
  // Exclusion is no such end (pullOf).
  const counted = pullable(heads, pulls).length;
  // While the bound holds a refresh cannot feed a Pull, so none of its
  // triggers runs: the first tick back under the bound refreshes and Pulls in
  // the same tick.
  const held = run.inFlight >= caps.bound;
  const trigger = refreshWhy({ draining: run.draining, held, status: current.status, entries: current.entries.length,
    unclaimed: counted, bound: caps.bound })
    ?? (run.draining === null && !held ? liftedPremise(run.excluded, current.entries, prs) : null);
  if (trigger) {
    const r = refresh();
    if (r.ok) {
      const excludedSet = new Set(run.excluded.map((x) => x.n));
      heads = unclaimed(r.entries, run);
      pulls = pullsOf(heads);
      supply = r.scanned;
      dropped = r.dropped;
      fresh = {
        ok: true, trigger, entries: r.entries.length,
        lifted: r.entries.filter((e) => excludedSet.has(e.n)).length,
        changed: r.entries.map((e) => e.n).join(",") !== current.entries.map((e) => e.n).join(","),
        // The count this trigger's text names, which the implementer row prints in place of the refreshed file's.
        ...(trigger === shortQueue(counted, caps.bound) ? { unclaimed: counted } : {}),
      };
    } else {
      fresh = { ok: false, trigger, why: r.why };
    }
  }

  const rows = reconcile({
    ...caps, ...run, heads, supply, dropped, shortlistStatus: current.status, refresh: fresh, mainCheckout, phase0, router, pulls,
  });
  const said = describe(mainCheckout, run.live);
  // The report files of the live members, read before the state file for the
  // reason given below. A member's report on disk is the outcome its message
  // was to carry, whether or not that message arrived.
  const reports = scratch === null ? new Map() : readReports(scratch.root, run.reporters);
  // Re-read rather than reusing priorState: this must be the freshest
  // snapshot, or this tick reverts whatever the heartbeat wrote while the
  // reads above were in flight. Read before the lines are built because the
  // liveness lines need the stamps it holds, and nothing between here and the
  // write below is I/O.
  const prev = readState(path, NAME);
  const now = Date.now();
  // Advisory only: a stale token prints a line asking the controller for the
  // registry census. It is not a row — it resets no `quiet`, moves no count
  // and frees no slot — and nothing here settles, kills or writes the ledger.
  const seen = stampSeen({ live: run.live, prev: prev.seen, controller: prev.controller, now });
  const ageless = prev.degraded ? ageChecks({ live: run.live, stems }) : [];
  if (ageless.length) console.error(`${NAME}: ${ageless.join(" and ")} not checked — ${path} ${prev.degraded}, so first-seen ages are unavailable`);
  const stale = livenessLines({ live: run.live, seen, thresholds: liveness, now });
  // Advisory the same way: a report on disk prints the settle it is for, and
  // nothing here runs it.
  const reported = reportLines({ reporters: run.reporters, reports, now, reportsFrom: scratch?.flagged ? reportsDir(scratch.root) : null });
  // Advisory the same way: a transcript the ledger records nowhere, and a live
  // member token with no transcript past `--no-transcript-after`. Neither is a
  // row, and nothing here dispatches, settles or kills.
  const transcribed = stems === null ? [] : [
    ...unrecordedLines({ stems, recorded: run.recorded }),
    ...noTranscriptLines({ live: run.live, seen, stems, session, after: noTranscriptAfter, now }),
  ];
  const above = [...(phase0.line === null ? [] : [phase0.line]), ...(said === null ? [] : [said]), ...stale.map((s) => s.line)];
  const rowLines = formatLines(rows);
  // The run is over once it is draining and nothing is left in flight: no
  // open PR and no implementer still holding a claim. Printed last and read
  // as actionable, so it never folds away: the stop it names is the run's
  // last act, and only the controller can write it.
  const over = run.draining !== null && prs.length === 0 && run.implLive === 0;
  if (over) rowLines.push(RUN_OVER);
  const advice = [...transcribed, ...reported];
  const lines = [...above, ...advice.map((a) => a.line), ...rowLines];

  // The back-off streak and the fold digest, written on EVERY tick: an edge
  // tick that dispatched is the clearest possible "there is work here". Digest,
  // not the lines themselves, so the file stays readable. A report or
  // NO-TRANSCRIPT line goes in without its age.
  const digest = createHash("sha256").update([...above, ...advice.map((a) => a.key), ...rowLines].join("\n")).digest("hex");
  const acts = actionable(rows) || over;
  // `seen` is pruned to the live set on the same write; an empty one removes
  // the key. A file that was degraded at this read is left byte-identical, so
  // a same-session rotate still refuses rather than judges none. `ticked` was
  // written at the top of the tick unless the file was degraded then; one
  // repaired since reaches this write without it, so this write carries the
  // stamp the top of the tick left out.
  if (!prev.degraded) {
    writeState(path, NAME, prev, {
      quiet: acts ? 0 : prev.quiet + 1, digest,
      seen: Object.keys(seen).length > 0 ? seen : undefined,
      ...(priorState.degraded ? { ticked: { at: tickedAt } } : {}),
    });
  }

  // Fold only when BOTH hold: nothing to act on, and nothing new to say. A
  // phase-0 or main-checkout hold still holding dispatch stays named on the
  // folded line — not actionable, so it never resets `quiet`, but the one
  // reason nothing dispatches must not drop out of view. Outside the digest,
  // which already covers it through the rows.
  if (fold && !acts && digest === prev.digest) {
    const held = holdReasons({ phase0, mainCheckout }).map((why) => `; HOLD (${why}) persists`).join("");
    // A stale member persists the same way: advisory, so it never resets
    // `quiet`, and named on the folded line for as long as it stays live
    // past its threshold. The digest already moves when its bucket does.
    const aged = stale.map((s) => `; CHECK-LIVENESS ${s.member} persists`).join("");
    // A report waiting on disk persists the same way, for as long as its
    // member stays live: the settle it is for, or REPORT-INVALID where that
    // settle would be refused.
    const settle = reported.filter((r) => r.settle || r.invalid).map((r) => `; ${r.settle ? "SETTLE" : "REPORT-INVALID"} ${r.member} persists`).join("");
    // A transcript the ledger lacks, or a live token lacking one, the same
    // way, for as long as it holds.
    const unmatched = transcribed.map((t) => `; ${t.kind} ${t.name} persists`).join("");
    // The to-spec drops the same way: advice, and the one reason an empty
    // shortlist is not "no work".
    const specs = specsDropped(dropped);
    const drops = specs ? `; ${specs} persists` : "";
    console.log(`fleet-tick: unchanged, nothing to act on (quiet=${prev.quiet + 1})${held}${aged}${unmatched}${settle}${drops} — full rows on the next change`);
    return;
  }
  for (const line of lines) console.log(line);
}

if (isCLI(import.meta.url)) main();
