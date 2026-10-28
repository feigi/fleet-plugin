// Pure board-model builder. No I/O and no clock read — `now` is passed in, so
// dwell/staleness is deterministic and unit-testable. board.mjs does the gh/
// ledger I/O and calls computeBoard(); every stage-derivation and flag decision
// lives here and is exercised by its unit tests (`node --test`).
//
// The THREE imports this module takes, all pure ones.
// fleet-state.mjs owns the heartbeat's `beat` key, and the rule for reading
// that key travels with it rather than being copied here. That module's own
// I/O (its path probe, its file read) is never called from this file; only
// assessBeat/isStalled/isReported/stallReport are, all of which are functions of their
// arguments. Importing the rule is what keeps the cockpit's stall wording and
// fleet-tick's identical — two spellings of "this run is dead" would be two
// answers the operator has to reconcile at 3am.
// ledger-grammar.mjs owns the member grammar (`<member>` live,
// `<member>=<outcome>` settled) and has no I/O at all; parseToken is read
// from it for the same reason — one grammar, one reader, so the cockpit and
// fleet-tick.mjs cannot disagree about which members are live.
// ledger-grammar.mjs owns a row's PR reading too, rowPr(), and a row with no
// impl token is read through it (see the paragraph below on a row with no
// `impl` token) so the cockpit and fleet-tick.mjs name the same PR for the
// same text, for a row that carries a PR-bound signal —
// an unsignaled row (no mention, no PR-bound member, no review=/reviewed=)
// still gets pr: null here while fleet-tick.mjs's own row-key fallback keys
// it to its ticket number regardless; see the same paragraph below.
// A card's review, finisher and fix-applier state is its PR's, read off
// fleet-tick.mjs's own per-PR fold (foldLedger, in its lenient mode: a token
// it cannot read is skipped and flags the row `ledger-error`, never thrown),
// not off the card's own row — a ticket retried under a new PR has that PR's
// tokens on another row. A fallback `#M` row for a PR a ticket row's latest
// attempt claims is that card's other half and renders no card of its own:
// its row-level signals (`ledger-error`, held-behind, the cause words, a live
// member) are the claiming card's.
// fleet-tick.mjs's I/O and main() never run here, main() being guarded on
// argv[1].
import { assessBeat, isStalled, isReported, stallReport, NO_OWNER } from "./fleet-state.mjs";
import { parseToken, rowPr, premisesOf, HALT_CAUSES, REVIEW, CELL, POLICY_CELL, parseRoutedEntry, tierValues, cellValues } from "./ledger-grammar.mjs";
import { latestFinisherAttempts, foldLedger, pastPinDue } from "./fleet-tick.mjs";
import { computeCellEvidence } from "./compute-cell-evidence.mjs";
import { admissibleRow, lastSegment } from "./pull-attribution.mjs";
import { dispatchModel } from "./member-outcomes.mjs";
import { HEAVY_BRIEF_CHARS, HEAVY_CRITERIA } from "./ticket-router.mjs";
import { implementerCell, modelsEqual } from "./tier-roles.mjs";

// A ledger row is freeform, controller-authored text. Two example shapes:
//   #<n> impl-<n>=PR#<m> → PR#<m> → MERGED 73b356de
//   #<n> impl-<n>=PR#<m> → PR#<m> · fix-pr-<m> · ruled:6-applies · held-behind:#<k>
// Extract by token, never by position — the controller reorders and appends
// tokens freely. Unknown text is ignored, never fatal.
//
// Member tokens are ledger-grammar.mjs's. On a row that has one, the
// row's latest `impl` attempt decides the card — the greatest retry suffix,
// wherever it sits (laterAttempt below): live → IMPLEMENTING, `=PR#M`
// → that PR decides, `=released`/`=bailed` → no card of
// the row's own (the POOL loop shows the ticket if it is still
// `ready-for-agent`), `=killed`/`=tier-mismatch`/`=blocked` → IMPLEMENTING with
// that outcome as a flag. There a `PR#` mention — the `→ PR#M` arrow or any
// other prose — is human-readable only; parseRow reads only the settled impl
// token's outcome, as rowPr() does for every reader. rowPr() takes the row's
// first settled `=PR#M` impl token, this card its latest attempt: the two
// differ only on a row carrying more than one impl token.
//
// A row with no `impl` token at all has no outcome to
// read, so it takes the tick's reading. `ledger.mjs dispatch <pr> fix-pr-<pr>` /
// `finisher-pr-<pr>` appends `#<pr> <member>` for a PR this run's
// implementers did not open. Once such a row carries a PR-bound signal — a
// `PR#M` mention, a `fix-pr-`/`finisher-pr-` member, `review=` or `reviewed=`
// — its PR is rowPr()'s, else the row key, and that PR decides the card as
// `=PR#M` does. An Exclusion never takes one.
//
// A member settled anywhere on the row is settled — a bare copy beside
// `<member>=<outcome>` is what a whole-line `row` rewrite leaves.
//
// A PR whose latest finisher attempt settled `halted:<cause>` carries
// that outcome as a severity-4 flag while the PR sits in REVIEW. The halt is
// the finisher working correctly — it refused to label — so the PR has no
// `ready-to-merge` until the controller resolves the cause; the flag is what
// puts it in front of a human. "Latest" is the reading `unlabelled` and
// `finisher:*` below share (latestFinisherAttempts, off the same rows and
// `## Dispatched` tokens): a live `-b` after the halt clears it, and a later
// attempt settled anywhere replaces it.
//
// A PR whose finisher settled `labelled` while the open list shows no
// `ready-to-merge` on it carries a severity-4 `unlabelled` flag in REVIEW —
// fleet-tick.mjs's own reading (unlabelledFinishers: the latest attempt since
// the last `label-off=`), off the same `## Dispatched` and row tokens the tick
// reads, so the card is flagged whenever the tick is repairing it or escalated
// it — including after a whole-line `row` rewrite dropped the settled token.
//
// A PR in REVIEW whose latest finisher attempt settled `failed` or `killed`
// while it is open and lacks `ready-to-merge` carries `finisher:failed` or
// `finisher:killed`, severity 4 — read off the same latest attempt and stretch
// as `unlabelled`, so the tick and the cockpit never read it two ways. The tick
// dispatches nothing for these; the flag is what puts the PR in front of a
// human. The names are not the bare `killed` flag, which is the implementer's.
//
// A PR's review is not a member: `review=wf:<runId>` is a Workflow
// with nobody to name, while `review=member:<name>` names a runner member,
// live until the token is settled `=failed` or a later `reviewed=` records
// its result.
//
// A `review=` token puts the PR under review only while it is live. A settled
// `review=…=failed` is a dead review and the PR is owed one again, as run-team
// SKILL.md defines review-due and as fleet-tick.mjs's `reviewedAny` reads the
// token: the PR is owed none while any row naming it carries ANY live
// `review=` — wherever it sits, not only as the last one — or any `reviewed=`.
// A `review=` token outside the grammar is read as live by foldLedger's
// lenient mode, which the board reads the PR's state through; the strict tick
// refuses that ledger outright instead, and the board flags the row.
//
// `#N excluded · behind-pr:#M` / `behind-issue:#M` is an Exclusion — pool
// supply, not a claim — read through ledger-grammar.mjs's premisesOf(), the
// reading shortlist.mjs and fleet-tick.mjs use too.
//
// ledger-grammar.mjs's REVIEW captures the matched kind, so parseRow tells a
// Workflow from a runner by that capture instead of a second scan; see the
// review notes above for what each kind means and how `=failed` settles it.

// Which of two well-formed impl tokens is the later attempt for THIS
// row's ticket. A token whose number matches the row's own ticket always
// outranks one that does not: a retry suffix only orders attempts on ONE
// number (ledger-grammar.mjs's MEMBER regex comment — "Attempts on one
// number order by it"), so comparing retry across a different ticket's
// number is meaningless and must never let a foreign token's suffix beat
// this ticket's own token (a dead-attempt-masks-a-live-implementer regression
// by a different mechanism than the one this ticket fixes). Within one
// ticket, read off ledger-grammar.mjs's parsed `retry` — no suffix first,
// then by letter — never off row position, so every ordering of one row's
// same-ticket impl tokens picks the same impl/outcome/pr. Between two
// distinct foreign numbers (a shape nothing writes), the greater number
// wins; two copies of one name tie, and its outcome is `implOutcomes`'
// latest settle.
const laterAttempt = (a, b, ticket) => {
  const aOwn = a.number === ticket, bOwn = b.number === ticket;
  if (aOwn !== bOwn) return aOwn;
  return (a.retry ?? "") !== (b.retry ?? "") ? (a.retry ?? "") > (b.retry ?? "") : a.number > b.number;
};

export function parseRow(row) {
  const issueM = row.match(/^#(\d+)\b/);
  if (!issueM) return null;
  const ticket = Number(issueM[1]);
  const mergedM = row.match(/\bMERGED\s+([0-9a-f]{7,40})\b/i);
  const heldM = row.match(/\bheld-behind[:\s]+#?(\d+)\b/i);
  const causes = [];
  for (const t of ["KILLED", "BLOCKED", "SHA-OFF-BRANCH"]) {
    if (new RegExp(`\\b${t}\\b`).test(row)) causes.push(t.toLowerCase());
  }
  const excluded = premisesOf(row);

  // `live` holds live entries in row order, each one of two kinds: a
  // ledger-grammar member (`kind: "member"`, its parsed token as `token`) or
  // a review runner a `review=member:` token names (`kind: "runner"`, a name
  // and nothing else — it is no ledger-grammar member, so it has none of a
  // parsed token's fields). A runner carries no
  // `token`, so reading a member field off one through `.token` throws
  // rather than reading `undefined`. `implOutcomes` holds each impl name's
  // latest well-formed outcome: only an impl outcome decides a card. A
  // malformed outcome is still a settle — never counted live, never decides
  // a card — but it is not silently dropped either: it earns the row a
  // `ledger-error` flag (deriveFlags below), the same "refuse rather than
  // guess" contract ledger-grammar.mjs's own docstring states `.error`
  // exists for.
  const live = [];
  const implOutcomes = new Map();
  const settled = new Set();
  let lastImpl = null; // the latest well-formed impl token (laterAttempt)
  let anyImpl = false;
  let prMember = false;
  let review = false; // any review= token: a PR-bound signal on a row with no impl token
  let reviewed = false;
  let runners = [];
  let malformed = false;
  for (const tok of row.split(/\s+/).filter(Boolean)) {
    const t = parseToken(tok);
    if (t) {
      if (t.error) malformed = true;
      if (t.outcome === null) live.push({ kind: "member", name: t.name, token: t });
      else settled.add(t.name);
      if (t.family === "impl") {
        anyImpl = true;
        if (!t.error) {
          if (t.outcome !== null) implOutcomes.set(t.name, t.outcome);
          if (!lastImpl || laterAttempt(t, lastImpl, ticket)) lastImpl = t;
        }
      }
      if (t.bound === "pr") prMember = true;
      continue;
    }
    if (tok.startsWith("review=")) {
      review = true;
      const { kind, name, failed } = REVIEW.exec(tok)?.groups ?? {};
      if (kind === "member") {
        if (failed) settled.add(name);
        else { live.push({ kind: "runner", name }); runners.push(name); }
      }
    } else if (tok.startsWith("reviewed=")) {
      reviewed = true;
      for (const r of runners) settled.add(r);
      runners = [];
    }
  }
  const alive = live.filter((e) => !settled.has(e.name));
  const implOutcome = lastImpl ? (implOutcomes.get(lastImpl.name) ?? null) : null;
  const prM = implOutcome && /^PR#(\d+)$/.exec(implOutcome);
  const implPr = prM ? Number(prM[1]) : null;
  let pr = implPr;
  // A row with NO impl token — a malformed one still
  // counts, since that row's key is a ticket — is keyed, once THIS row
  // carries a PR-bound signal, the way fleet-tick.mjs's rowPr-then-
  // row-key logic would: rowPr()'s first `PR#` mention (itself a signal), else the
  // row key when the first word is exactly `#N`. fleet-tick.mjs's own
  // row-key fallback (deriveRun) is NOT itself gated on a signal — this
  // module's extra gate exists so an ordinary unclaimed ticket never
  // borrows its own number as a phantom PR. An Exclusion is supply and
  // never takes a PR, whatever text it carries.
  if (!anyImpl && excluded === null) {
    const own = rowPr(row);
    if (own !== null) pr = own;
    else if ((prMember || review || reviewed) && row.split(/\s/)[0] === issueM[0]) pr = Number(issueM[1]);
  }
  return {
    issue: Number(issueM[1]),
    excluded,
    impl: lastImpl?.name ?? null,
    implOutcome,
    implPr,
    agent: alive.length ? alive[alive.length - 1].name : null,
    pr,
    merged: !!mergedM,
    sha: mergedM ? mergedM[1] : null,
    heldBehind: heldM ? Number(heldM[1]) : null,
    causes,
    malformed,
  };
}

// A parsed row's column, or null when the row claims no card of its own (a
// released or bailed implementer: the ticket went back to the tracker, and the
// POOL loop shows it if it is still `ready-for-agent`). An Exclusion is POOL.
// MERGED is an explicit `MERGED <sha>` token or, failing one, `prState.merged`
// — gh's answer for a row PR absent from the open list, or a
// carry-forward of the previous board's MERGED for that SAME PR on that
// ticket: MERGED is terminal, so a merged PR never reopens regardless of
// what this run's merged read says — but a ticket retried under a NEW PR
// after its earlier one merged gets no such carry-forward; that new PR's
// state is unknown, not MERGED. READY needs the live PR label, the mapped
// `ready-to-merge` string `readyToMerge` (null with no Label map, which
// makes no PR READY); any other PR, closed-unmerged included, is in REVIEW.
export function deriveColumn(parsed, prState, readyToMerge) {
  if (parsed.excluded) return "POOL";
  if (parsed.merged) return "MERGED";
  if (parsed.pr != null) {
    if (prState && prState.merged) return "MERGED";
    if (prState && readyToMerge != null && prState.labels.includes(readyToMerge)) return "READY";
    return "REVIEW";
  }
  if (parsed.implOutcome === "released" || parsed.implOutcome === "bailed") return null;
  return "IMPLEMENTING";
}

// Dwell thresholds per column, ms. A ticket sitting longer than this in a
// non-terminal column earns `stale`. POOL and MERGED are absent → never stale.
export const STALE_MS = {
  IMPLEMENTING: 20 * 60 * 1000,
  REVIEW: 45 * 60 * 1000,
  READY: 15 * 60 * 1000,
};

// An Exclusion's badges are its premises, `excluded:#<n>` for a number and
// `excluded:<branch>` for a branch name, and nothing else: it is supply, so no
// dwell clock and no cause applies. isBadge() keeps them out of `attention`.
export function deriveFlags(parsed, ctx) {
  if (parsed.excluded) {
    return parsed.excluded.length
      ? parsed.excluded.map(({ target }) => `excluded:${target.length > 0 && !/[^0-9]/.test(target) ? "#" : ""}${target}`)
      : ["excluded"];
  }
  const flags = [];
  if (parsed.malformed) flags.push("ledger-error");
  if (ctx.ci === "red") flags.push("red-ci");
  if (parsed.heldBehind != null) flags.push(`held-behind:#${parsed.heldBehind}`);
  for (const c of parsed.causes) flags.push(c); // killed | blocked | sha-off-branch
  const o = parsed.implOutcome;
  if ((o === "killed" || o === "tier-mismatch" || o === "blocked") && !flags.includes(o)) flags.push(o);
  // Only while the halt still parks the PR: once a human resolves an
  // escalated halt by labelling or merging it, the flag has nothing to ask.
  // `past-pin`'s own automatic resolution (SKILL.md "Resolving a finisher
  // halt") re-reviews the PR through fleet-tick.mjs, but a returned
  // `reviewed=` does not itself clear the latest finisher outcome here — the halt is
  // answered only once "its result reaches a fresh finisher through the
  // same gate" (ibid.), so the card stays flagged, same as any other halt
  // cause, until that finisher settles. reviewBacklog below reads the same
  // gap the other way: still counted due for a fresh review while this flag
  // is up and the head has not caught up to what was reviewed.
  if (ctx.finisher?.startsWith("halted:") && ctx.column === "REVIEW") flags.push(ctx.finisher);
  if (ctx.finisher === "labelled" && ctx.column === "REVIEW") flags.push("unlabelled");
  if ((ctx.finisher === "failed" || ctx.finisher === "killed") && ctx.column === "REVIEW") flags.push(`finisher:${ctx.finisher}`);
  // A closed-unmerged PR's card reads `pr-closed` in place of `stale`: the
  // closed PR is what a reader has to act on, not how long the card has sat.
  const prClosed = ctx.prClosed === true && ctx.column === "REVIEW";
  if (prClosed) flags.push("pr-closed");
  const limit = STALE_MS[ctx.column];
  if (!prClosed && limit != null && ctx.sinceEnteredStage != null && ctx.now - ctx.sinceEnteredStage > limit) {
    flags.push("stale");
  }
  return flags;
}

const isBadge = (flag) => flag === "excluded" || flag.startsWith("excluded:");

// ---------------------------------------------------------------------------
// The card's Cell line: which Cell the card's latest Pull ran on, and why.
// ---------------------------------------------------------------------------

// A part of a Cell line: its words, whether they are a hole drawn dim and
// italic ("not on record"), the hash it links to, and the separator the page
// puts before it (" · " unless said otherwise).
const NOT_ON_RECORD = "not on record";
const part = (text, o = {}) => ({ text, dim: false, href: null, sep: " · ", ...o });
const hole = (o = {}) => part(NOT_ON_RECORD, { dim: true, ...o });
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// A transcript's member record, as gather() keeps it, put the way the figures
// read an implementer row (member-outcomes.mjs): its definition, its level
// ("-" is no level), and its dispatch model keyed as the Cell generation is.
function dispatchRecord(m) {
  return {
    subagentType: typeof m.subagent_type === "string" ? m.subagent_type : "",
    effort: typeof m.thinking === "string" && m.thinking !== "-" ? m.thinking : "",
    dispatchModel: dispatchModel(m.resolvedModelIdentity),
    resolved: m.resolvedModelIdentity ?? null,
    model: m.model ?? null,
  };
}

// The row's implementers, in attempt order: its own ticket's impl tokens, or
// every impl token when it names none of its own.
function implementersOf(row, issue) {
  const all = row.split(/\s+/).map(parseToken).filter((t) => t && !t.error && t.family === "impl");
  const own = all.filter((t) => t.number === issue);
  const seen = new Set();
  return (own.length ? own : all)
    .filter((t) => !seen.has(t.name) && seen.add(t.name))
    .sort((a, b) => a.number - b.number || (a.retry ?? "").localeCompare(b.retry ?? ""))
    .map((t) => t.name);
}

// The words of a recorded reason, after the draw's, and whether they name the
// policy row. `REASON` keeps only the first thing that went wrong, and nothing
// here guesses the rest.
function reasonWords(r, table) {
  const drawn = r.draw !== null;
  const row = `${r.objective} row`;
  switch (r.reason) {
    case "ok": {
      if (drawn) return [];
      const follows = table !== null && !Object.hasOwn(table.rows[r.objective], r.stratum);
      const href = `#cells/row/${r.objective}/${follows ? "*" : r.stratum}`;
      return [part(`${row}, ${r.stratum}`, { href }), ...(follows ? [part("follows *")] : [])];
    }
    case "table-cell-tripped": {
      const named = r.tripped.length === 1 ? `${row}'s ${r.tripped[0]}` : `${row}'s Cell (one of ${r.tripped.join(", ")})`;
      return [part(`${named} tripped${drawn ? "" : ": default Cell"}`, { href: `#cells/row/${r.objective}/${r.stratum}` })];
    }
    case "guard-tripped":
      return [part(drawn ? `left out as tripped: ${r.tripped.join(", ")}` : "every other Cell tripped: no draw")];
    case "guard-missing": return [part("no cost guard yet: default Cell only")];
    case "no-issue-json": return [part("issue unreadable when routed")];
    case "no-sizing": return [part("no sizing")];
    default: return [part(`recorded as ${r.reason}`)];
  }
}

// The Stratum and the numbers that set it.
function stratumWords(r) {
  if (r.sized !== null) return `${r.stratum}: sized ${r.sized}`;
  if (r.brief === null) return `${r.stratum}: no brief read`;
  if (r.reason === "no-sizing") return `${r.stratum}: no sizing`;
  const past = (n, at) => `${n > at ? "past" : "not past"} ${grouped(at)}`;
  return `${r.stratum}: ${grouped(r.brief)} chars (${past(r.brief, HEAVY_BRIEF_CHARS)}), ${r.criteria} criteria (${past(r.criteria, HEAVY_CRITERIA)})`;
}

// "<model> · <level>" off a dispatch record, holes where it carries none.
function modelParts(rec, sep) {
  if (rec === null) return [hole({ sep })];
  return [rec.dispatchModel ? part(rec.dispatchModel, { sep }) : hole({ sep }), rec.effort ? part(rec.effort) : hole()];
}

const cellHref = (cell, generation) => `#cells/${cell}${generation ? `@${generation}` : ""}`;

/**
 * The Cell line of a card whose ledger row has an impl token, or
 * null when it has none: `{ cell, generation, lines: [why, stratum], mark,
 * targets }`. `generation` is the Pull's (its first Admissible implementer's
 * dispatch model), null when none is on record; `targets` is every guard entry
 * the line links to, `{ cell, generation }`, its Cell's and a rescue's.
 * `lines` are lists of parts (`part` above); `mark` is null or `{ text,
 * severity }`, severity `amber` or `red` (red: the Pull counts in no Cell's
 * figures). `routed` is the ledger's `## Routed` entries, `agents` its
 * `## Dispatched` member → `agent=` map, `members` each implementer's member
 * record by name (`{ model, resolvedModelIdentity, thinking, subagent_type }`)
 * and `table` the installed router table, or null. Pure: the Routing is shown
 * as recorded and never re-checked against today's guard.
 */
export function cellLine({ row, issue, routed = [], agents = {}, members = new Map(), table = null }) {
  const names = implementersOf(row, issue);
  if (names.length === 0) return null;

  // The latest Pull: the last implementer with a `## Routed` entry, those after
  // it rescues or retries under it. A row with no entry predates the Routing,
  // and its latest Pull is its latest impl token, at the row's Cell: its
  // `tier=` is rewritten to the Cell each later implementer runs at, so an
  // earlier one cannot be told off a rescue.
  const entries = new Map();
  for (const e of routed) {
    const sp = typeof e === "string" ? e.indexOf(" ") : -1;
    if (sp === -1 || entries.has(e.slice(0, sp))) continue;
    entries.set(e.slice(0, sp), { routing: parseRoutedEntry(e)?.routing ?? null, raw: e.slice(sp + 1) });
  }
  const start = names.findLastIndex((n) => entries.has(n));
  const under = start === -1 ? names.slice(-1) : names.slice(start);
  const recorded = start === -1 ? null : entries.get(names[start]);
  const routing = recorded?.routing ?? null;
  const cell = routing?.cell ?? tierValues(row)[0] ?? cellValues(row)[0] ?? POLICY_CELL;
  const level = CELL.exec(cell)?.[2] ?? null;
  const expected = `fleet-implementer-${cell}`;

  const recs = under.map((n) => (members.has(n) ? dispatchRecord(members.get(n)) : null));
  const tierOk = (n) => row.split(/\s+/).find((w) => w.startsWith(`tier-ok=${n}:`))?.slice(`tier-ok=${n}:`.length) || null;
  const ranAs = (n, i) => (Object.hasOwn(agents, n) ? agents[n] : null) ?? tierOk(n) ?? (recs[i]?.subagentType || null);
  const admissible = recs.map((rec) => (rec === null ? null : admissibleRow(rec, cell)));
  const firstAdmissible = admissible.indexOf(true);
  const generation = firstAdmissible === -1 ? null : recs[firstAdmissible].dispatchModel;

  // Line 1: the Cell, then why. A `tier=` that names no Cell (a hand-edited
  // row) has no guard entry to land on, so it links nowhere and books nothing.
  const isCell = CELL.test(cell);
  const why = [part(cell, { href: isCell ? cellHref(cell, generation) : null, sep: "" })];
  const targets = isCell ? [{ cell, generation }] : [];
  if (routing !== null) {
    if (routing.draw !== null) why.push(part(`drawn ${routing.draw.k} of ${routing.draw.K}: ${routing.by === "burn-in" ? "burn-in" : "every 5th Pull"}`));
    why.push(...reasonWords(routing, table));
  } else if (recorded !== null) {
    why.push(part(`recorded as ${recorded.raw}`));
  } else {
    const route = row.split(/\s+/).find((w) => w.startsWith("route="));
    why.push(route ? part(`recorded as ${route.slice("route=".length)}`) : hole());
  }
  const rescue = under.map((n, i) => ({ i, at: i === 0 ? null : implementerCell(ranAs(n, i) ?? "") })).findLast((x) => x.at !== null && x.at !== cell);
  if (rescue !== undefined) {
    const rec = recs[rescue.i];
    const gen = rec !== null && admissibleRow(rec, rescue.at) ? rec.dispatchModel : null;
    why.push(part(`rescue at ${rescue.at}`, { href: cellHref(rescue.at, gen) }), ...modelParts(rec, " "));
    targets.push({ cell: rescue.at, generation: gen });
  }

  // Line 2: the Stratum with its numbers, then the model and level of the
  // Pull's first implementer at its Cell.
  const shown = recs[firstAdmissible === -1 ? 0 : firstAdmissible];
  const stratum = [routing !== null ? part(stratumWords(routing), { sep: "" }) : hole({ sep: "" }), ...modelParts(shown, " · ")];
  if (shown !== null && shown.model !== null && shown.resolved !== null && !modelsEqual(shown.model, shown.resolved)) {
    stratum.push(part(`fell back to ${shown.model}`));
  }

  // The mark: the first implementer, the one the Pull's Cell binds, ran off it.
  let mark = null;
  const first = recs[0];
  const said = ranAs(under[0], 0);
  let off = null;
  if (admissible[0] !== true) {
    const defOff = first !== null ? first.subagentType !== expected : said !== null && said !== expected;
    if (defOff) {
      const as = said !== null && said !== expected ? said : first?.subagentType || "no definition on record";
      off = { first: `first ran as ${as}`, alone: `ran as ${as}` };
    } else if (first !== null && !first.dispatchModel) {
      off = { first: "first ran with no model on record", alone: "no model on record" };
    } else if (first !== null && first.effort !== level) {
      const at = first.effort ? `at ${first.effort}` : "with no thinking level on record";
      off = { first: `first ran ${at}, not ${level}`, alone: `ran ${at}, not ${level}` };
    }
  }
  if (off !== null) {
    if (admissible.slice(1).includes(true)) mark = { text: `⚑ ${off.first}`, severity: "amber" };
    else if (admissible.includes(null)) mark = { text: `⚑ ${off.alone}: not checked`, severity: "amber" };
    else mark = { text: `⚑ ${off.alone}: no Admissible row, so it counts in no Cell's figures`, severity: "red" };
  }

  return { cell, generation, lines: [why, stratum], mark, targets };
}

// Internal helpers — not exported; covered through computeBoard's tests.

// Carry the stage-entry timestamp forward while the column is unchanged, else
// reset to now. This is what makes dwell self-contained in board.json, needing
// no ledger timestamps and no controller involvement.
function stageEntry(prevTicket, column, now) {
  if (prevTicket && prevTicket.column === column && prevTicket.sinceEnteredStage != null) {
    return prevTicket.sinceEnteredStage;
  }
  return now;
}

function titleFor(issue, pr, issues) {
  if (pr && pr.title) return pr.title;
  const i = issues.find((x) => x.number === issue);
  return i ? i.title : `#${issue}`;
}

const FLAG_SEVERITY = {
  "red-ci": 5, "ledger-error": 5, killed: 4, "tier-mismatch": 4, "pr-closed": 4, blocked: 4, "sha-off-branch": 4, unlabelled: 4,
  "finisher:failed": 4, "finisher:killed": 4,
  ...Object.fromEntries(HALT_CAUSES.map((c) => [`halted:${c}`, 4])),
  stale: 1,
};
function severity(flags) {
  let s = 0;
  for (const f of flags) {
    if (f.startsWith("held-behind")) s = Math.max(s, 2);
    else s = Math.max(s, FLAG_SEVERITY[f] ?? 0);
  }
  return s;
}

function splitNumbered(line) {
  const m = line.match(/^#(\d+)\s+(.*)$/);
  return m ? { issue: Number(m[1]), subject: m[2] } : { issue: null, subject: line };
}

// The stall surface, or null when there is nothing to say.
//
// The two facts the report needs beyond the mark itself — what is claimed and
// whether the pool still has supply — are read off THIS model rather than
// re-queried, which is the whole reason this lives here and not in gather().
// A ticket in flight is one the ledger placed past POOL and short of MERGED:
// a row exists for it, so it was claimed, and it has not landed, so the claim
// is still outstanding. That is the same population the `in-progress` label
// marks, arrived at from the ledger instead of from a label query the cockpit
// has no reason to run.
//
// `ledgerOk`/`poolOk` gate `claimed`/`supply` at `null`, never a computed
// zero, the moment either input did not actually read — the same "unknown is
// not zero" contract fleet-state.mjs's stallReport() states in its own words
// and fleet-tick.mjs's CLI side already honours. `tickets`/`pool` derive
// straight from `ledger.rows`/`issues`, which reduce to the empty array on
// either a genuinely empty read AND a failed one alike (gather()'s tryRun/
// tryParse fallback) — so without this gate, a `gh`/ledger outage prints the
// exact same "0 claimed, pool supply 0" a healthy drained run would, which is
// the one report an operator has no reason to distrust and every reason to.
//
// The verdict carries `text` — the rendered line — because board.html is
// served as one self-contained file with no imports: a page that formatted
// this itself would be a second wording of the same verdict, free to drift
// from fleet-tick's the moment either is edited. The page renders; the rule
// and its words stay here.
//
// `owner` is whose stall it is, fleet-state.mjs's stallOwner() answer: it
// reads the process table, which is I/O, so gather() judges it and this
// function only words it. Absent is no controller named.
//
// The previous run's recorded stop is shown too, until this run's first tick
// lands: it is that run's end, worded as such, with nothing of this run's on
// it.
function stall(marks, tickets, pool, { ledgerOk, poolOk, owner }, now) {
  const verdict = assessBeat({ ...marks, now });
  if (!isReported(verdict)) return null;
  if (!isStalled(verdict)) return { ...verdict, text: stallReport(verdict) };
  const claimed = ledgerOk ? tickets.filter((t) => t.column !== "POOL" && t.column !== "MERGED").length : null;
  const supply = poolOk ? pool : null;
  return { ...verdict, claimed, supply, owner, text: stallReport(verdict, { claimed, supply, owner }) };
}

// Which of gather()'s `gh ... list` reads came back exactly as long as
// its own `--limit` — and so may have been cut there, gh saying nothing — as
// one rendered line, or null when neither did. The pool's count carries its
// own `n+` besides (computeBoard below); this line is for what a count cannot
// say: a pool card that is not there at all, and an open PR past the cap,
// which reaches this model only through the ledger row and the merged read,
// so it renders REVIEW with CI unknown whatever its real label and run say.
// Rendered here, not on the page, for stall()'s reason just above.
function capNotice({ poolCapped, prsCapped }) {
  const parts = [];
  if (poolCapped) parts.push("the ready-for-agent read hit its --limit, so POOL may be missing tickets");
  if (prsCapped) parts.push("the open-PR read hit its --limit, so a PR past it shows REVIEW with CI unknown");
  return parts.length ? parts.join("; ") : null;
}

// The previous board already showed this SAME PR MERGED on this
// ticket. MERGED is terminal, so that verdict stands whatever this run's
// merged read says. Keyed on the PR, not just the ticket: a ticket retried
// under a NEW PR after its earlier one merged carries no MERGED verdict
// forward for that new, unrelated PR. One definition, because computeBoard()
// applies it and mergedReadPrs() skips what it covers — two copies could
// drift into a PR that neither is asked about nor carried.
function carriedMerged(prevTicket, p) {
  return prevTicket?.column === "MERGED" && prevTicket.pr === p.pr;
}

// The row PRs whose merged status gather() has to ask gh about this
// tick — exactly those computeBoard() would consult `merged` for and cannot
// already place: a row PR absent from the open list `prs`, on a row that is
// not an Exclusion (always POOL), carries no `MERGED <sha>` token, has a PR
// at all, and is not carried forward as MERGED. Sorted and unique. Empty
// means no merged read is needed at all. `prev` is the previous board, as
// computeBoard() takes it.
//
// `Number.isSafeInteger(p.pr)` excludes a row whose PR mention is 22+ digits:
// `Number()` renders it in exponential form (`1e+21`), which is not a valid
// `pullRequest(number:)` argument/alias and fails gh's WHOLE batched query
// (measured: `p1e+21:pullRequest(number:1e+21)` gets GitHub's parser
// rejecting the query outright — no `data` at all, unlike a merely
// nonexistent PR number, which resolves to a per-alias NOT_FOUND beside a
// usable body). Leaving it out of `need` costs that one row the REVIEW it
// would get from a failed batch anyway, and keeps every other row PR's
// lookup intact.
export function mergedReadPrs({ ledger, prs, prev }) {
  const open = new Set(prs.map((p) => p.number));
  const prevByIssue = new Map((prev?.tickets || []).map((t) => [t.issue, t]));
  const need = new Set();
  for (const p of (ledger.rows || []).map(parseRow).filter(Boolean)) {
    if (p.excluded || p.merged || p.pr == null || !Number.isSafeInteger(p.pr) || open.has(p.pr)) continue;
    if (carriedMerged(prevByIssue.get(p.issue), p)) continue;
    need.add(p.pr);
  }
  return [...need].sort((a, b) => a - b);
}

// The ticket issues whose row's latest settled impl PR is one of `prs`, sorted
// and once each. gather() reads their state in the same call as the PR read;
// computeBoard() takes the CLOSED ones as `closedIssues`. An Exclusion is none.
// An issue number outside Number.isSafeInteger is left out for the reason
// mergedReadPrs() leaves such a PR out: its `i1e+21` alias would fail the
// whole batched query, PR aliases included.
export function issuesOfPrs({ ledger, prs }) {
  const set = new Set(prs);
  const issues = (ledger.rows || []).map(parseRow).filter(Boolean)
    .filter((p) => !p.excluded && p.implPr != null && set.has(p.implPr) && Number.isSafeInteger(p.issue))
    .map((p) => p.issue);
  return [...new Set(issues)].sort((a, b) => a - b);
}

// `merged` is gh's list of merged PR numbers, consulted only for a row
// PR absent from the open list `prs`; absent means none known, and a PR in
// neither list (closed unmerged, or a failed read) keeps REVIEW — unless
// carriedMerged() holds for it, in which case it stays MERGED
// whether this run's merged read failed outright or simply succeeded
// without listing it. A PR that IS in the open list is never eligible for
// this carry-forward — only the "absent from both `prs` and (maybe)
// `merged`" branch below ever consults it. gather() asks gh only about
// mergedReadPrs()'s set, so `merged` never lists more than that.
// `closed` is the same read's CLOSED PRs, and `closedIssues` the CLOSED issues
// among issuesOfPrs(). A pr-closed flag needs both: a missing `closed`
// flags nothing, and a failed issue read reads as not CLOSED, as closedTickets()
// reads its own failed probe.
// `roles` is the Label map gather() read (every Label role -> the tracker's
// string), null when it could not be read, with `labelMapError` saying why.
// With no map no PR is READY and none is known to lack `ready-to-merge`, so
// `unqueued` is empty rather than every open PR: a PR its finisher labelled
// would otherwise flag `unlabelled` off a label nobody could name.
export function computeBoard(inputs) {
  const { ledger, issues, prs, ci, prev, now } = inputs;
  const readyToMerge = inputs.roles?.["ready-to-merge"] ?? null;
  const prByNum = new Map(prs.map((p) => [p.number, p]));
  const mergedPrs = new Set(inputs.merged || []);
  const closedPrs = new Set(inputs.closed || []);
  const closedIssues = new Set(inputs.closedIssues || []);
  const prevByIssue = new Map((prev?.tickets || []).map((t) => [t.issue, t]));
  const ruledByPr = new Map();
  for (const r of ledger.ruled || []) {
    const s = splitNumbered(r);
    if (s.issue != null) ruledByPr.set(s.issue, s.subject);
  }

  const rows = ledger.rows || [];
  const fold = foldLedger({ rows, dispatched: ledger.dispatched || [] }, new Set(prs.map((p) => p.number)), { lenient: true });
  const parsed = [];
  for (const [i, row] of rows.entries()) {
    const p = parseRow(row);
    if (p) parsed.push({ ...p, row, malformed: p.malformed || fold.malformed.has(i) });
  }
  // Each implementer's member record by its name, for the Cell lines: the
  // transcripts gather() read, this run's session's or, between runs, the
  // previous run's.
  const members = new Map((inputs.implementers || []).map((m) => [lastSegment(m.member), m]));
  const lineInputs = { routed: ledger.routed || [], agents: ledger.agents || {}, members, table: inputs.routerTable };
  // The ticket row each PR's latest attempt settled to, first row wins.
  const claimedBy = new Map();
  for (const p of parsed) if (p.impl !== null && p.pr != null && !claimedBy.has(p.pr)) claimedBy.set(p.pr, p);
  // A fallback `#M` row — no impl token of its own, keyed to its own ticket
  // number — for a PR a ticket row's latest attempt claims is that card's other
  // half, not a second card: what the row says about the PR goes onto the
  // claiming card, and a live member on it is the card's agent.
  const cards = [];
  for (const p of parsed) {
    const claimer = p.impl === null && p.pr === p.issue ? claimedBy.get(p.pr) : undefined;
    if (claimer === undefined) { cards.push(p); continue; }
    claimer.malformed ||= p.malformed;
    claimer.heldBehind ??= p.heldBehind;
    for (const c of p.causes) if (!claimer.causes.includes(c)) claimer.causes.push(c);
    claimer.agent = p.agent ?? claimer.agent;
    claimer.merged ||= p.merged;
  }
  const unqueued = readyToMerge === null ? new Set()
    : new Set(prs.filter((p) => p.state === "OPEN" && !(p.labels || []).includes(readyToMerge)).map((p) => p.number));
  const latestFinishers = new Map(latestFinisherAttempts({ rows, dispatched: ledger.dispatched || [] }, unqueued).map((u) => [u.pr, u.outcome]));
  // Review state is the PR's, read off the tick's own fold — a card's
  // PR is its row's latest attempt, whichever row carries that PR's tokens.
  const liveMember = (names) => [...names].some((n) => fold.members.get(n).outcome === null);
  const reviewOwed = (prNum) => {
    const st = fold.byPr.get(prNum);
    if (st === undefined) return true;
    if (st.inFlight || liveMember(st.fixMembers) || liveMember(st.finishers)) return false;
    return !st.reviewedAny || pastPinDue(st, prByNum.get(prNum)?.headRefOid);
  };
  const rowIssues = new Set();
  const tickets = [];

  for (const p of cards) {
    const pr = p.pr != null ? prByNum.get(p.pr) : undefined;
    const prevTicket = prevByIssue.get(p.issue);
    const prState = p.pr == null ? null
      : pr ? { open: pr.state === "OPEN", labels: pr.labels || [] }
           : { open: false, labels: [], merged: mergedPrs.has(p.pr) || carriedMerged(prevTicket, p) };
    const column = deriveColumn(p, prState, readyToMerge);
    if (column === null) continue; // released/bailed: the POOL loop below decides
    rowIssues.add(p.issue);
    const sinceEnteredStage = stageEntry(prevTicket, column, now);
    const ciState = p.pr != null ? (ci[p.pr] ?? "unknown") : null;
    const prClosed = pr === undefined && p.implPr != null && closedPrs.has(p.pr) && !closedIssues.has(p.issue);
    const flags = deriveFlags(p, { ci: ciState, column, sinceEnteredStage, now, finisher: latestFinishers.get(p.pr), prClosed });
    tickets.push({
      issue: p.issue,
      title: titleFor(p.issue, pr, issues),
      column,
      agent: p.agent,
      pr: p.pr,
      ci: ciState,
      sinceEnteredStage,
      flags,
      ruling: p.pr != null ? (ruledByPr.get(p.pr) ?? null) : null,
      // A POOL card (an Exclusion) carries none, and cellLine gives a PR-only
      // row none, since it has no impl token.
      cellLine: column === "POOL" ? null : cellLine({ row: p.row, issue: p.issue, ...lineInputs }),
    });
  }

  // A wayfinder:* ticket is documentation-only regardless of its triage role:
  // candidates.mjs's dispatch scan never surfaces one even carrying
  // `ready-for-agent`, so this POOL column must not either, or an
  // undispatchable ticket inflates the operator's read of available work.
  // Filtered HERE rather than out of gather()'s gh query: `issues` also feeds
  // titleFor() above, and a query-level exclusion silently strips a
  // wayfinder-labelled issue's title lookup too, turning an unrelated ledger
  // row's card into a bare `#<number>` even though only the POOL card was
  // ever supposed to change.
  for (const iss of issues) {
    if (rowIssues.has(iss.number)) continue;
    if ((iss.labels || []).some((l) => l.startsWith("wayfinder:"))) continue;
    const sinceEnteredStage = stageEntry(prevByIssue.get(iss.number), "POOL", now);
    tickets.push({
      issue: iss.number, title: iss.title, column: "POOL", agent: null,
      pr: null, ci: null, sinceEnteredStage, flags: [], ruling: null, cellLine: null,
    });
  }

  const attention = tickets.filter((t) => t.flags.some((f) => !isBadge(f)))
    .sort((a, b) => severity(b.flags) - severity(a.flags));

  // Backlog is a PR nobody has reviewed and nobody is reviewing: no live
  // `review=` (a settled `=failed` one is no review), no
  // `reviewed=`, and no live fix-applier or finisher on the PR — or
  // a returned review whose finisher halted `past-pin` against a head it
  // never read: owed again until the head catches up to what `reviewed=`
  // recorded, the same rule fleet-tick.mjs's reviewDue reads off headRefOid
  // (pastPinDue). A PR absent from the open list (closed, not yet MERGED)
  // reads as an unmatched head, never as answered — silence is not review.
  // Counted once per PR, off the per-PR fold, however many cards name it.
  const reviewBacklog = new Set(tickets.filter((t) => t.column === "REVIEW" && reviewOwed(t.pr)).map((t) => t.pr)).size;
  const cardsInPool = tickets.filter((t) => t.column === "POOL").length;
  // A capped pool read makes this count a floor, and it says so the way
  // fleet-tick.mjs's claimed count does — `"100+"`, never a bare 100 that
  // reads as exact. stall() below receives the same value, so the stall line
  // and the footer cannot disagree about it. A pool that was not read (`gh`
  // failed, or no Label map named the label to ask for) is null, never 0: an
  // empty POOL reads as no work.
  const poolOk = inputs.poolOk ?? true;
  const pool = !poolOk ? null : inputs.poolCapped ? `${cardsInPool}+` : cardsInPool;

  return {
    generatedAt: now,
    interval: inputs.interval ?? 15,
    repo: inputs.repo ?? null,
    repoUrl: inputs.repoUrl ?? null,
    // Which workspace this board describes and which port served it.
    // Pass-through, exactly like repo/repoUrl above and for the same reason —
    // resolveCockpitInstance() answers both at the gather boundary, and this
    // module reads no cwd, no git and no socket, so it cannot re-derive either
    // and must not try. Defaulted to null rather than left undefined: a
    // missing key and a null one are the same value to a reader in JS but not
    // in the JSON on disk, and the launch handshake reads `workspace` off
    // that JSON — a dropped key would make every board anonymous to it.
    workspace: inputs.workspace ?? null,
    port: inputs.port ?? null,
    queue: { pool, supply: pool, reviewBacklog },
    capNotice: capNotice(inputs),
    // Null when the Label map was read; else what POOL and READY lack and the
    // reader's reason, which names the derivation step that writes the map.
    labelMapNotice: inputs.roles ? null
      : `no Label map was read, so POOL and READY are unknown${inputs.labelMapError ? `: ${inputs.labelMapError}` : ""}`,
    tickets,
    filed: (ledger.filed || []).map(splitNumbered),
    // Not derivable from anything else in this model: a ledger that was never
    // read, one read empty, and one whose payload would not parse all reduce to
    // the same empty lists. gather() is the
    // only caller that can tell them apart, so it says so and this carries the
    // answer to the page. Defaulted rather than required — every other caller
    // of computeBoard builds its inputs by hand and means a ledger it read.
    ledgerState: ledger.state ?? "read",
    // Telemetry, not pipeline state: null when this run has produced no
    // transcripts yet, `{ ok: false, error }` when they cannot be read,
    // `{ ok: true, ... }` when they can. Those are deliberately not the same
    // value — the UI hides the panel on null rather than rendering zeroes,
    // which would read as "this run was free", and shows the error, which is
    // a bug the operator has to act on.
    spend: inputs.spend ?? null,
    // Telemetry beside `spend`, and under the same rule: a liveness
    // input can only ever POPULATE or OMIT this field, and nothing above it
    // reads `inputs.beat` — no column, no flag, no dwell clock, no attention
    // row. A dead controller does not move a ticket; it means nobody is
    // moving the tickets, which is a different statement and belongs in a
    // different field.
    //
    // Null for "nothing to report", which covers both a run that has never
    // beaten and one that is beating normally — the page hides the banner on
    // either, because a banner that fires on every healthy tick is a banner
    // the operator learns to read past.
    // The marks pass through bare, unlike `spend` two fields up: that
    // coalesce is load-bearing because the value is serialised into
    // board.json as-is, while these are only ever fed to assessBeat(),
    // which already treats `undefined` and `null` identically — a `?? null`
    // here would cost a line to say nothing stall() does not already do.
    //
    // `ledgerOk`/`poolOk` default to true absent a signal, matching
    // `ledgerState`'s own `?? "read"` default just above: every caller that
    // builds inputs by hand (every test in this suite) means a read that
    // succeeded, and only gather() — which now sets both — can say otherwise.
    liveness: stall({ beat: inputs.beat, ticked: inputs.ticked, acted: inputs.acted, controller: inputs.controller }, tickets, pool, {
      ledgerOk: (ledger.state ?? "read") === "read",
      poolOk,
      owner: inputs.stallOwner ?? NO_OWNER,
    }, now),
    attention,
    // The Cell evidence tab's model (compute-cell-evidence.mjs), built from the
    // guard, the receipts' metrics steps, the definitions and the carried
    // `modelRoles` read gather() answered, and this run's Pulls: each card's
    // Cell line, booked As-routed to its Cell. A caller that read none of them
    // (every hand-built input in this suite) gets the tab's no-guard state:
    // computeCellEvidence reads an input left out as nothing read.
    cellEvidence: computeCellEvidence({
      guard: inputs.guard,
      receipts: inputs.receipts,
      agents: inputs.agents,
      modelRoles: inputs.modelRoles,
      pulls: tickets.filter((t) => t.cellLine).map((t) => ({ issue: t.issue, cell: t.cellLine.cell, mark: t.cellLine.mark, targets: t.cellLine.targets })),
    }),
    // The `omp config get modelRoles` read, carried tick to tick the way `ci`
    // and `repo` are: `{ value, readAt, error }`, read at most once a minute.
    modelRoles: inputs.modelRoles ?? null,
  };
}
