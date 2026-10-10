#!/usr/bin/env node
// The reconcile tick. run-team's Phase 3 is an event loop, and implementer
// refill was wired as an EDGE — "a member finished → refill its slot". That
// edge dies the moment live implementers reach 0, because 0 implementers emit
// no completion event, and "free capacity + a non-empty pool" is a LEVEL
// condition an edge-triggered loop cannot observe once it stops changing. Measured:
// implementers sat at 0/target with pool 1 and ~57 `ready-for-agent` in supply
// until a human asked why nothing was being implemented. No error, no warning.
//
// So compute the deficit instead of remembering it. Every wake ends in one
// invocation (record, tick, act, beat), and each prints
// actual/target and a named ACTION per role — `PULL #<n> #<n>`, `DISPATCH
// fix-pr PR#<pr>`, `DISPATCH review PR#<pr>`, `DISPATCH merge-bot`, `HOLD (…)`,
// `REFRESHED shortlist: …` — with run-team's guards applied in code rather than
// recalled from its table. You cannot forget what a script prints at you.
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
//             tier mismatches and the drain marker
//             all come off it. A missing ledger is a fresh run: zero rows.
//   shortlist `.fleet/shortlist.json`, shortlist.mjs's output, resolved against
//             the git common dir as ledger.mjs resolves the ledger. Its
//             entries minus every ticket with an `impl-` row, or an `excluded`
//             row whose premise still holds, are the heads a PULL names; its
//             `scanned` is the supply. Missing or unparsable is depth 0 and a
//             refresh, never a refusal: the depth only ever bounds PULLs
//             downward.
//   gh        The open PRs, by label, by whether they close an issue and by
//             GitHub's `mergeable` — the merge queue, which PRs are owed a
//             review, and which conflict. Also, for each ticket
//             holding the implementer row on a tier mismatch, whether its issue
//             is CLOSED (`gh issue view`): a closed ticket's mismatch
//             holds nothing. And, for each in-flight `review=` token whose PR
//             the open list does not carry, whether that PR is MERGED or
//             CLOSED (`gh pr view`): a review cannot be running against a
//             finished PR, so its dangling token holds no reviewer slot.
//   main      The main checkout against the run-start baseline
//             `.fleet/main-checkout.sha`, through main-checkout.mjs.
//             Anything but `clean` — dirty, unknown, no baseline — prints one
//             MAIN-CHECKOUT-* line and holds every dispatching row until the
//             maintainer clears it; it never refuses the tick.
//   guard     `.fleet/cost-guard.json` beside the shortlist, pr-cost.mjs
//             --guard's verdict on the implementer cells. Printed as the
//             `router` row and never acted on here: a missing or unreadable
//             file reads DEFAULT-ONLY, the way the router (not in the tree
//             yet) is to read it. pr-cost.mjs writes the main
//             workspace's file by default, the one read here.
//
// The pure half below is `reconcile()` over the counts `deriveRun()` reads off
// the ledger; main() does the I/O. Split so the guard table and the reading are
// both unit-testable without a network.

import { parseMember, parseToken, premisesOf, rowNums, REVIEW, REVIEWED } from "./ledger-grammar.mjs";

// Every role's TARGET is its configured cap. Availability of work belongs in
// the ACTION, not the target: a reviewer target that shrank to the backlog
// would print `0/0 → idle` and read as "correctly sized" for the exact drained
// state that is the defect.
//
// The reviewer rows are computed first because the implementer row's gate
// reads what they leave: the slots this tick's own dispatches fill.
export function reconcile(s) {
  const rev = reviewers(s);
  // The conflict rows only ask the controller to write a record — never to
  // dispatch — so they stand outside the main-checkout hold: the fix-applier a
  // conflict hold leads to obeys the hold through its own role's row.
  return [
    ...mainCheckoutHold(s, [implementers(s, rev.left), ...rev.rows]),
    ...rev.conflictRows,
    ...mainCheckoutHold(s, [mergeBot(s)]),
    ...shortlistRows(s),
    ...routerRows(s),
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
function mainCheckoutHold(s, rows) {
  const why = mainCheckoutHoldReason(s.mainCheckout);
  if (why === null) return rows;
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
// transcript and so does not know the session directory: `<session>` stays a
// placeholder the controller fills in, as `<file>` does — one batch file, one
// entry per held member (SKILL.md's phase-2 tier check).
const tierCheckStep = (members) => "run ~/.fleet/bin/fleet-run tier-check.mjs --batch <file> with "
  + JSON.stringify(members.map((member) => ({ member, session: "<session>" })));

// A mismatch clears when the next attempt on the ticket is dispatched at its
// row's tier: one retry letter past the HIGHEST any impl member of that ticket
// has used, not past the held member's own — a controller can dispatch `-c`
// before `-b`, ledger.mjs refuses a name already dispatched, and the highest
// letter is what compute-board.mjs's laterAttempt reads as the latest attempt.
// No suffix is the `a` attempt (ledger-grammar.mjs orders it first). `-z` is
// the grammar's last, so past it there is no legal name to print.
function replaceStep(held, implNames) {
  const named = [], stuck = [];
  for (const name of held) {
    const { family, number } = parseMember(name);
    const top = [name, ...implNames].map(parseMember).filter((m) => m.number === number)
      .map((m) => m.retry ?? "a").sort().at(-1);
    if (top === "z") stuck.push(name);
    else named.push(`${family}-${number}-${String.fromCharCode(top.charCodeAt(0) + 1)}`);
  }
  return [
    named.length ? `dispatch ${named.join(", ")} ${named.length > 1 ? "each " : ""}at its row's tier` : "",
    stuck.length ? `${stuck.join(", ")} ${stuck.length > 1 ? "have" : "has"} no retry letter left` : "",
  ].filter(Boolean).join("; ");
}

function implementers(s, left) {
  const row = mkRow("implementers", s.implLive, s.implCap,
    `unclaimed=${s.heads.length} supply=${s.supply ?? "?"} unreviewed=${left.unreviewed}`
    + (s.shortlistStatus === "ok" ? "" : ` shortlist=${s.shortlistStatus}`));

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
  // dispatch repeats whatever it got wrong. Running the check is the
  // controller's own step, so it is asked to act, with the command in the
  // detail.
  if (s.tierUnchecked.length) {
    return row(`HOLD (tier unchecked ${s.tierUnchecked.join(" ")})`, { acts: true, extra: tierCheckStep(s.tierUnchecked) });
  }

  const deficit = s.implCap - s.implLive;
  if (deficit <= 0) return row("AT CAP");

  // The review-backlog gate, NARROWED: more PRs into a review-bound
  // pipeline buy nothing — but the pipeline is review-bound only when a PR is
  // still owed its review after this tick's dispatches AND no reviewer slot is
  // left for it. A deep backlog with free slots is a reviewer-row DISPATCH on
  // this same tick, not a reason to idle an implementer; the old
  // `backlog >= 2` gate held there and starved implementers.
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

// Reviewer units: an in-flight review = 1, each fix-applier = 1.
// Named in priority order — fix-appliers first, then reviews, oldest first —
// because finishing what is started beats starting more. Reviews are also
// bounded by `--max-reviews`, left at its default (the reviewer cap) since
// every review unit already counts against the session's own concurrency
// semaphore; the other slots still serve fix-appliers.
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
  // A finisher settled `labelled` on a PR the open list shows without
  // `ready-to-merge`. One such attempt since the controller's last deliberate
  // removal gets one fresh finisher; a second one escalates, never a third
  // dispatch. Finishers take no reviewer slot, so neither waits on the cap.
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
  // instead — no hold, no fix-applier. Neither row takes a reviewer slot, and
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
  if (!rows.length) {
    const owed = s.fixDue.length + s.reviewDue.length;
    if (owed && free <= 0) rows.push(row("AT CAP"));
    else if (s.reviewDue.length) rows.push(row(`HOLD (max-reviews ${s.maxReviews} in flight)`));
    else if (!unlabelledRows.length) rows.push(row("IDLE OK"));
  }
  rows.push(...unlabelledRows);
  return { rows, conflictRows, left: { unreviewed: s.reviewDue.length - reviews.length, free } };
}

function mergeBot(s) {
  // Cap is 1 by invariant, not by configuration.
  const row = mkRow("merge-bot", s.mergeBotLive, 1, `merge-queue=${s.mergeQueue} held=${s.mergeHeld}`);
  if (s.mergeBotLive >= 1) return row("AT CAP");
  if (s.mergeQueue === 0) return row("IDLE OK");
  // `ready-to-merge` is the author's sign-off and nothing more. A bot
  // dispatched against a queue whose candidates are all held — behind a lower
  // open PR, or on a conflict merge-bot already refused to force —
  // spends a whole member re-deriving a verdict already recorded.
  if (s.mergeQueue - s.mergeHeld <= 0) {
    const why = s.mergeConflictHeld ? "behind a lower PR or on a merge conflict no fix-pr has cleared" : "behind a lower PR";
    return row("HOLD", { extra: `every queued candidate is held ${why}` });
  }
  return row("DISPATCH merge-bot", { acts: true });
}

// The refresh this tick ran, if it ran one. A REFRESHED that changed the list
// is actionable — supply arrived. One that changed nothing is not: every idle
// heartbeat tick refreshes while the shortlist is short of the cap, and an
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
const HELD = /^held-behind[:-]#?(\d+)$/;
// The durable record that a PR conflicts — written onto the held PR's own
// row by the merge bot, when its local-rebase fallback hits a conflict it would
// not force, or by the controller off this tick's `CONFLICT` line — and
// spelled like `held-behind` so the two read alike. Distinct from an
// Exclusion, which gates a ticket's claim; this gates a PR's merge.
const CONFLICT_HOLD = /^conflict-hold[:-]#?(\d+)$/;
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

export function deriveRun({ rows, dispatched, drain }, prs, closed = new Set(), finished = new Set()) {
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
  const note = (t, where, rowPr) => {
    if (t.error) throw new LedgerError(`${where}: ${t.name}: ${t.error}`);
    const m = members.get(t.name) ?? { name: t.name, family: t.family, number: t.number, outcome: null };
    if (t.outcome !== null && (t.bound !== "pr" || rowPr === undefined || t.number === rowPr)) m.outcome = t.outcome;
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
  for (const text of rows) {
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
    // while a hold did is the conflict fix-applier `ledger.mjs dispatch` named
    // a `fleet-implementer-<cell>`: it rebases and never sees the review file,
    // so it clears the hold and answers no finding. Each fix-applier
    // does one of those jobs once, so its landing folds once per PR
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
    };
    // The finisher-pr token currently deciding `pastPinHalt`, picked by
    // retry suffix ("" < "b" < "c" …) the same way compute-board.mjs's
    // laterAttempt does — never by row-text position. A
    // `-b` retry can sit before an older `halted:past-pin` token after a row
    // rewrite, and text order must not read the stale one as the live
    // finisher's replacement. Reset at each `reviewed=`, since `pastPinHalt`
    // is defined relative to the latest one (see the comment above `st`).
    let latestFinisher = null;
    for (const tok of text.split(/\s+/).filter(Boolean)) {
      const t = parseToken(tok);
      if (t) {
        note(t, where, pr);
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
        if (t.family === "finisher-pr" && t.number === pr
          && (!latestFinisher || (t.retry ?? "") > (latestFinisher.retry ?? ""))) {
          latestFinisher = t;
          st.pastPinHalt = members.get(t.name).outcome === "halted:past-pin";
        }
        continue;
      }
      if (tok.startsWith("review=")) {
        const m = REVIEW.exec(tok);
        if (!m) throw new LedgerError(`${where}: '${tok}' is not review=wf:<runId> | member:review-pr-<n> | fallback:review-pr-<n>, optionally =failed`);
        st.inFlight = !m.groups.failed;
        if (!m.groups.failed) st.reviewedAny = true;
      } else if (tok.startsWith("reviewed=")) {
        const m = REVIEWED.exec(tok);
        if (!m && REVIEWED_RUNLESS.test(tok)) {
          throw new LedgerError(`${where}: '${tok}' names no review run — reviewed= is now <head>:<survived>/<refuted>/<unverified>:<run>, `
            + "<run> the run-XXXXXXXX directory holding that review's review.json; rewrite the token with `ledger.mjs row`");
        }
        if (!m) throw new LedgerError(`${where}: '${tok}' is not reviewed=<head>:<survived>/<refuted>/<unverified>:<run>`);
        latestFinisher = null;
        Object.assign(st, {
          inFlight: false, reviewedAny: true, survived: Number(m[2]), unverified: Number(m[4]), reviewFixed: false,
          reviewedHead: m[1].toLowerCase(), reviewedRun: m[5], pastPinHalt: false,
        });
      } else if (labelOffMember(tok) === null) {
        throw new LedgerError(`${where}: '${tok}' is not label-off=<finisher-pr member> — fix the row with \`ledger.mjs row\``);
      } else {
        const h = HELD.exec(tok);
        if (h) st.held.push(Number(h[1]));
        const c = CONFLICT_HOLD.exec(tok);
        if (c) {
          // Bound to the row's own PR: a hold naming another PR is a
          // misrecorded one, and read on a guess it would either hold the
          // wrong PR or leave this one silently stalled.
          if (Number(c[1]) !== pr) {
            throw new LedgerError(`${where}: '${tok}' names PR #${c[1]}, but this row is ${pr === null ? "no PR's" : `PR #${pr}'s`} — a conflict hold goes on the held PR's own row`);
          }
          // A fresh hold is unresolved whatever settled before it, the way a
          // fresh `reviewed=` resets `reviewFixed` above. A redundant re-hold
          // (merge-bot retrying a PR it has already held) changes
          // nothing a live fix-applier holds off: liveness is not read off
          // token order.
          st.conflictOpen = true;
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

  const all = [...members.values()];
  const live = (family) => all.filter((m) => m.family === family && m.outcome === null).length;
  const impls = all.filter((m) => m.family === "impl");
  for (const m of impls) claimed.add(m.number);
  // Only the LATEST member for a ticket counts. A mismatch is fixed by
  // dispatching a replacement (`impl-N-b`) at the right tier; until that
  // replacement's own check passes, the row holds — a replacement that is
  // ALSO mismatched keeps holding, and one not yet checked holds as
  // unchecked. A member with no verdict at all holds whether it is live or
  // settled — the tick never reads a transcript, so only tier-check.mjs can
  // say whether one exists; a settled member whose transcript was never
  // written gets `tier-unverifiable=` from it, which clears the hold here.
  const newest = impls.filter((m, i) => !impls.some((o, j) => j > i && o.number === m.number));
  // A mismatch on a ticket whose issue is CLOSED holds nothing: there
  // is nothing left for `impl-<N>-b` to replace, and a retired definition can
  // never re-check. `closed` is the ticket numbers the caller has probed; the
  // pure fold cannot probe, so none is the default and every mismatch holds.
  // A still-open ticket keeps its hold.
  const mismatched = (m) => m.outcome === "tier-mismatch" || verdicts.mismatch.has(m.name);
  const tierMismatch = newest.filter((m) => mismatched(m) && !closed.has(m.number)).map((m) => m.name);
  const cleared = (m) => verdicts.ok.has(m.name) || verdicts.unverifiable.has(m.name);
  const tierUnchecked = newest.filter((m) => !mismatched(m) && !cleared(m)).map((m) => m.name);
  const isQueued = (p) => p.labels.some((l) => l && l.name === "ready-to-merge");
  const queued = prs.filter(isQueued);
  const asc = (a, b) => a - b;
  const state = (n) => byPr.get(n);
  const heldBehind = (st) => (st?.held ?? []).some((n) => open.has(n));
  const conflictHeld = (st) => st !== undefined && st.conflictOpen;
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
  // The halt holds only while the head is still past what was reviewed: a
  // `reviewed=` head (7-40 hex) prefix-matching gh's full headRefOid is the
  // head that review read, and there is nothing more to review.
  const pastPinDue = (st, head) => st !== undefined && st.pastPinHalt && !st.inFlight && st.reviewedHead !== null
    && !String(head).toLowerCase().startsWith(st.reviewedHead);
  // A `review=` token with no `reviewed=` after it reads as in flight, and the
  // ledger alone never says otherwise: a review whose own `reviewed=` write
  // never landed stays in flight after its PR merges, holding a reviewer slot
  // for good. `finished` is the PR numbers the caller has found MERGED or
  // CLOSED, and a finished PR has no review running against it. A PR on the
  // open list is open whatever `finished` says, and none is the default, so a
  // PR nobody has asked about keeps its review live.
  const reviewing = [...byPr.entries()].filter(([, st]) => st.inFlight);
  const liveReviews = reviewing.filter(([n]) => open.has(n) || !finished.has(n));
  return {
    implLive: live("impl"),
    fixLive: live("fix-pr"),
    mergeBotLive,
    reviewsLive: liveReviews.length,
    // The in-flight reviews of PRs the open list does not carry: the ones
    // `finished` could retire, so the caller asks gh about these and no others.
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
    // chore PR closing nothing is review work nobody in the run will ever be
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
    mergeHeld: queued.filter((p) => heldBehind(state(p.number)) || conflictHeld(state(p.number))).length,
    // How many of those are conflict holds — the HOLD row's wording, no field.
    mergeConflictHeld: queued.filter((p) => conflictHeld(state(p.number))).length,
    // Finishers settled `labelled` on an open PR without the label.
    unlabelled: unlabelledFinishers({ rows, dispatched },
      new Set(prs.filter((p) => !isQueued(p)).map((p) => p.number))),
    // Every PR, open or not, on a conflict hold no fix-applier has cleared —
    // the one reading of a hold: `ledger.mjs dispatch` names a
    // fix-applier's definition and refuses a finisher off this list, so it
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
      ...all.filter((m) => m.outcome === null).map((m) => m.name),
      ...liveReviews.map(([n]) => `review:PR#${n}`),
    ],
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
    .filter((e) => e.premises.every(({ kind, target }) => kind !== "pr" || !isDigits(target)))
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

// Why this tick refreshes the shortlist, or null. The premise-lifted
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
import { fileURLToPath } from "node:url";
import { isCLI } from "./is-cli.mjs";
import { parseArgs } from "node:util";
import { makeDie, isDigits } from "./arg.mjs";
import { gitEnv } from "./git-env.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { statePath, readState, writeState, assessBeat, isStalled, stallReport, stallOwner } from "./fleet-state.mjs";
import { checkMainCheckout, describe } from "./main-checkout.mjs";

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
  // Defaults here, not threaded through int(): declared this way they still
  // go through the guard below, where a hand-passed default went round it.
  // No hard cap on either role, defaults only.
  "implementer-cap": { type: "string", default: "2" },
  "reviewer-cap": { type: "string", default: "6" },
  // Reviews in flight at once. Default = the reviewer cap; run-team's own
  // guidance is to leave it there rather than pass a tighter bound.
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
    // The digits rule, called rather than restated. Digits, not
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
      "--json", "number,labels,closingIssuesReferences,headRefOid,mergeable"], { encoding: "utf8", timeout: GH_TIMEOUT_MS });
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
  // an empty list and drop every open PR from review work. headRefOid likewise
  // — absent, a `halted:past-pin` PR would read as moved forever — and
  // mergeable: absent or outside GitHub's MergeableState enum, no PR would ever
  // read CONFLICTING.
  if (!Array.isArray(prs) || prs.some((p) => !p || typeof p.number !== "number"
    || !Array.isArray(p.labels) || !Array.isArray(p.closingIssuesReferences)
    || typeof p.headRefOid !== "string" || !MERGEABLE_STATES.includes(p.mergeable))) {
    die("gh pr list did not return {number,labels,closingIssuesReferences,headRefOid,mergeable} rows, mergeable one of MERGEABLE, CONFLICTING, UNKNOWN");
  }
  if (prs.length === PR_LIMIT) {
    die(`exactly ${PR_LIMIT} open PRs — the list is capped and may be truncated. Raise PR_LIMIT; a backlog that silently drops PRs is not a reconcile.`);
  }
  return prs;
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
        const r = spawnSync("gh", ["issue", "view", target, "--json", "state"], { encoding: "utf8", timeout: GH_TIMEOUT_MS, env: gitEnv({ GH_REPO: "" }) });
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

// The tickets, of those holding the implementer row on a tier mismatch, whose
// issue is CLOSED: the one live read deriveRun needs to lift a hold
// whose replacement has nothing left to replace. One `gh issue view` per
// mismatched ticket, and none when nothing is mismatched. A probe that cannot
// answer — a nonzero exit, or a reply carrying no issue state — is disclosed
// and the hold stands.
function closedTickets(mismatched) {
  const closed = new Set();
  for (const { number } of mismatched.map(parseMember)) {
    const r = spawnSync("gh", ["issue", "view", String(number), "--json", "state"], { encoding: "utf8", timeout: GH_TIMEOUT_MS, env: gitEnv({ GH_REPO: "" }) });
    if (r.error || r.status !== 0) {
      console.error(`${NAME}: ${failure(r, `gh issue view ${number}`)} — tier mismatch on #${number} unconfirmed closed, hold stands`);
      continue;
    }
    let st = null;
    try { st = JSON.parse(r.stdout).state; } catch { /* no state: disclosed below */ }
    if (st === "CLOSED") closed.add(number);
    else if (typeof st !== "string") {
      // Exit 0 with a body that is not an issue (an HTML error page, a proxy's
      // text, JSON with no state) is as unanswered as a nonzero exit.
      console.error(`${NAME}: gh issue view ${number} printed no state — tier mismatch on #${number} unconfirmed closed, hold stands`);
    }
  }
  return closed;
}

// The PRs, of those whose review the ledger reads as in flight yet the open
// list does not carry, that gh says are MERGED or CLOSED. A review cannot be
// running against a finished PR, so the ledger's dangling `review=` token must
// not hold a reviewer slot for good. A probe that cannot answer — a nonzero
// exit, a reply carrying no state, a state that is none of the three — is
// disclosed and the review keeps its slot: an unreadable state is never read
// as finished. A PR gh calls OPEN keeps it quietly.
function finishedReviewPrs(offList) {
  const finished = new Set();
  for (const number of offList) {
    const r = spawnSync("gh", ["pr", "view", String(number), "--json", "state"], { encoding: "utf8", timeout: GH_TIMEOUT_MS, env: gitEnv({ GH_REPO: "" }) });
    if (r.error || r.status !== 0) {
      console.error(`${NAME}: ${failure(r, `gh pr view ${number}`)} — review on PR#${number} unconfirmed finished, its slot stands`);
      continue;
    }
    let st = null;
    try { st = JSON.parse(r.stdout).state; } catch { /* no state: disclosed below */ }
    if (st === "MERGED" || st === "CLOSED") finished.add(number);
    else if (st !== "OPEN") {
      console.error(`${NAME}: gh pr view ${number} printed no PR state — review on PR#${number} unconfirmed finished, its slot stands`);
    }
  }
  return finished;
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

function main() {
  const { fold, state: path, ...caps } = options();
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
  const verdict = assessBeat({ beat: priorState.beat, ticked: priorState.ticked, now: Date.now() });
  if (isStalled(verdict)) {
    console.log(stallReport(verdict, { claimed: claimed(), supply: current.scanned, owner: stallOwner(priorState, NAME) }));
  }

  // Every read happens before anything prints: a partial tick is worse than no
  // tick, because half a reconcile still reads like a reconcile.
  const prs = openPrs();
  let run;
  try {
    const ledger = readLedger();
    run = deriveRun(ledger, prs);
    const closed = closedTickets(run.tierMismatch);
    const finished = finishedReviewPrs(run.reviewsOffList);
    if (closed.size || finished.size) run = deriveRun(ledger, prs, closed, finished);
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

  // The main checkout against the run's baseline, on every tick — the
  // backstop for what member-write-guard cannot see. Never a refusal of the tick:
  // every answer but `clean` is a hold on the dispatching rows plus one line
  // saying why, so the rest of the run keeps reporting.
  const mainCheckout = checkMainCheckout();

  const rows = reconcile({
    ...caps, ...run, heads, supply, shortlistStatus: current.status, refresh: fresh, mainCheckout, router,
  });
  const said = describe(mainCheckout, run.live);
  const lines = [...(said === null ? [] : [said]), ...formatLines(rows)];

  // The back-off streak and the fold digest, written on EVERY tick: an edge
  // tick that dispatched is the clearest possible "there is work here". Digest,
  // not the lines themselves, so the file stays readable. Re-read rather than
  // reusing priorState: this must be the freshest snapshot, or this tick
  // reverts whatever the heartbeat wrote while the reads above were in flight.
  const prev = readState(path, NAME);
  const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
  const acts = actionable(rows);
  // `ticked`, fleet-tick's own liveness key: written on every tick that gets
  // past its refusals — a refused tick (exit 2) writes none; this tick
  // reaching here IS the occurrence.
  writeState(path, NAME, prev, { quiet: acts ? 0 : prev.quiet + 1, digest, ticked: { at: Date.now() } });

  // Fold only when BOTH hold: nothing to act on, and nothing new to say. A
  // main-checkout hold still holding dispatch stays named on the folded line
  // — not actionable, so it never resets `quiet`, but the one reason
  // nothing dispatches must not drop out of view. Outside the digest, which
  // already covers it through the rows.
  if (fold && !acts && digest === prev.digest) {
    const why = mainCheckoutHoldReason(mainCheckout);
    const held = why === null ? "" : `; HOLD (${why}) persists`;
    console.log(`fleet-tick: unchanged, nothing to act on (quiet=${prev.quiet + 1})${held} — full rows on the next change`);
    return;
  }
  for (const line of lines) console.log(line);
}

if (isCLI(import.meta.url)) main();
