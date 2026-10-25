#!/usr/bin/env node
// Writer and checker for docs/metrics/tier-outcomes.tsv. The `tier` column
// used to be typed by hand from what the controller
// MEANT to dispatch and was never compared with what ran: two rows said
// `opus` for implementers dispatched as a generic `task` that ran
// sonnet/high, which is neither tier arm.
//
//   append <pr> [--note <text>] [--sizing light|heavy] [--profile <p>] [--loc <n>]
//          [--files <n>] [--scratch <dir>]
//   append <pr> --closed-own-ticket yes|no --minted-false-claim yes|no --note <text>
//          [--sizing light|heavy] [--profile <p>] [--loc <n>] [--files <n>] [--scratch <dir>]
//     Fills `run_date` (today's UTC date, the ruling date), `pr`, `ticket` (the
//     PR's one `gh pr view --json closingIssuesReferences,url` issue in its own
//     repository; when the PR closes zero or several there, the N of its one
//     settled `impl-<N>=PR#<pr>` token in the run ledger), `tier`, the two
//     verdict columns and the `note` (see "The verdicts" below) and, unless
//     `--sizing` names it, `sizing` (see below). Idempotent by
//     PR: a row already present is named and nothing is written, exit 0.
//     Every refusal writes no row and exits 2.
//   check [--live]
//     Post-switch rows only: a filled `tier` must equal the short name of the
//     ticket's single implementer row in member-outcomes.tsv, and that row
//     must be a `fleet-implementer*` definition — exit 1 otherwise, and exit 1
//     when none of the latest run_date's filled rows could be compared and some
//     lack a member row (nothing from that run was checked). `--live`
//     (a run in progress; CI never passes it) adds a WARNING, never a
//     failure, per PR whose run-ledger row carries `reviewed=` but which has
//     no row here. A PR whose closing references are not exactly one, and that
//     no settled `impl-` token names, is named in a `note` line and never
//     warned about: `append` has no ticket to key a row on. Where such tokens
//     do name it but `append` would still refuse it, its WARNING says why. A
//     read of that PR that does not answer keeps the warning, after a line
//     naming why the read failed. Both reads of a PR's closing references
//     ignore an ambient GH_REPO and give `gh` 60s. `--ledger <path>` names
//     another ledger than the run's own.
//
// `tier` resolution, in order (never tie-broken by `run_date`: the two files'
// `run_date`s mean different things — this file's header measures 92 of 267
// PRs whose date here is on no member row of theirs):
//   1. the `tier-ok=impl-<N>:<definition>` token tier-check.mjs wrote on the
//      ticket's row of THIS run's ledger (there is one ledger per run);
//   2. else the ticket's single implementer row in member-outcomes.tsv, when
//      its `subagent_type` is a `fleet-implementer*` definition — the PR ruled
//      in a later run than the one that dispatched it;
//   3. else blank, with a WARNING naming why.
// A ledger mismatch is positive evidence the implementer did NOT run under
// its definition, so it blanks the tier rather than letting step 2 reach an
// older dispatch of the same ticket — read from either the free-text
// `tier-mismatch=impl-<N>:<definition>` token tier-check.mjs writes when the
// member is already settled some other way, or the member's own settled
// `impl-<N>=tier-mismatch` outcome, tier-check.mjs's main path for a mismatch
// caught while the member is still live.
//
// Values are definition SHORT NAMES, never a vendor family:
// `fleet-implementer` is `default`, `fleet-implementer-<x>` is `<x>` (`alt`,
// or a per-cell name). Rows dated before TIER_SWITCH_DATE hold the old
// `opus`/`sonnet` spelling and are never checked; the header records the
// switch and how the old values map.
//
// `sizing` resolution, in order:
//   1. `--sizing`, as given — it wins, and stderr names it as the source;
//   2. else the `sizing.verdict` of the ticket's implementer report,
//      `<scratch>/reports/impl-<ticket>[-x].json` (`--scratch`, default the
//      root scratch-root.mjs prints), the highest retry letter's when several
//      exist — and only when the report checks against its schema, its
//      `sizing.ranBeforePr` is true and its `sizing.signal` is non-empty: a
//      verdict typed after the PR was opened measured nothing, and one with no
//      signal named is a guess;
//   3. else blank, with a WARNING naming each condition that failed.
//
// A row's position in the file is its order: rows are appended, never inserted
// mid-file or reordered. An in-place edit (a re-judged `class`, a backfilled
// verdict) keeps the row's position; a ruling meant to supersede an earlier one
// is appended. Readers pick a ticket's ruling by file order, not by `run_date`.
//
// Exit codes: 0 ok, 1 `check` found a mismatch or checked nothing from the latest
// run_date (see `check`), 2 usage, unreadable input or a refused `append`.

// The verdicts. With no verdict flag, `closed_own_ticket` and
// `minted_false_claim` are worked out from the Charges the fix-applier
// recorded on the standing findings of the PR's first review, and the `note`
// is composed from them, so the row explains itself once the evidence is
// reclaimed:
//   - the review is ledger-grammar.mjs's firstReview() over the PR's ledger
//     tokens: the first `reviewed=` that either counted no survived and no
//     unverified finding or that a fix-applier answered. Its `review.json` is
//     `<scratch>/pr<pr>/<run>/review.json`, and its head and its survived and
//     unverified counts are the ledger token's, or it refuses;
//   - the record is the last answering that review's run:
//     `<scratch>/dispositions-fix-pr-<pr>[-x].json` with the highest retry
//     letter whose `run` is the review's run. It is read whatever
//     dispositions-check.mjs concluded about its remedies;
//   - a finding stands as dispositions-check.mjs's `stands` says. `unmet` or
//     `both` on one fails `closed_own_ticket`, `false-claim` or `both` makes
//     `minted_false_claim` yes. A review that counted no survived and no
//     unverified finding is a pass and needs no record;
//   - a standing finding with no Charge, or a review, `review.json` or record
//     that is missing, refuses. So does a record entry that names no finding
//     of the review, or a second entry for a finding an earlier entry
//     answers. A dimension that never ran does not: the note names it.
//   - the Ruling itself is deriveRuling's, exported and pure: it takes the
//     review's run and head, its findings and a record lookup, and reads no
//     file. `append` reads the review and the record and ties them to the
//     ledger, then calls it once.
// The note reads `review <run> at <head7>, record <file>: <bucket>[<index>]
// <charge> "<claim>"; …; none: <bucket>[<index>] <reason>, …; cleared:
// survived[<index>] false-rationale, …; unrun: <dimension>, …`, and ` — <--note>`
// when `--note` is given. Tabs and newlines in a claim become spaces.
//
// Verdicts given by hand — `--closed-own-ticket` and `--minted-false-claim`
// together, with `--note` naming the evidence — are written as given for a PR
// GitHub reports MERGED, and refused for any other. A merged PR given no
// verdict flags is derived when its evidence is still in scratch, and
// otherwise refused with the flags to give.

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCLI } from "./is-cli.mjs";
import { makeDie, defineFlags, isDigits } from "./arg.mjs";
import { parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { parseMember, parseToken, memberTokens, rowPr, prTokens, firstReview } from "./ledger-grammar.mjs";
import { CHARGES, CHARGE_REASONS, reviewProblem, sameHead, stands } from "./dispositions-check.mjs";
import { rowText } from "./tier-check.mjs";
import { latestImplReport, readReport, reportsDir, defaultScratch } from "./report-files.mjs";
import { FleetDirUnresolvable } from "./fleet-dir.mjs";
import { ownClosingIssues } from "./closing-refs.mjs";

const NAME = "tier-outcomes";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEDGER_SCRIPT = join(SCRIPT_DIR, "ledger.mjs");

// ---------------------------------------------------------------------------
// pure core — exercised through the CLI by its tests; only
// COLUMNS, LEGACY_WIDTH, TIER_SWITCH_DATE, parseTierOutcomes, rulingsByTicket,
// rulingFor, lastPullByTicket and deriveRuling are imported directly, the rest
// through argv
// ---------------------------------------------------------------------------

// APPENDED TO, never inserted into: every awk read-out in the file's header
// and in run-team/references/pull.md (**Accumulate per PR, never conclude a
// tier result inside one run**) indexes by position.
export const COLUMNS = Object.freeze([
  "run_date", "pr", "ticket", "class", "tier", "closed_own_ticket",
  "minted_false_claim", "note", "sizing", "profile", "loc", "files",
]);
// Rows predating the four difficulty covariates are SHORT on purpose.
export const LEGACY_WIDTH = COLUMNS.length - 4;

// The first `run_date` whose `tier` is a definition short name. Also the
// date of the header's switch note.
export const TIER_SWITCH_DATE = "2026-09-29";

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE_DEFINITION = "fleet-implementer";
// The two quality-floor columns `append` writes. Every reader fails the floor
// on exactly `minted_false_claim=yes` or `closed_own_ticket=no`, so any other
// spelling would read as a pass.
export const VERDICT = Object.freeze(["yes", "no"]);
export const VERDICT_COLUMNS = Object.freeze(["closed_own_ticket", "minted_false_claim"]);

// `fleet-implementer` -> `default`, `fleet-implementer-<x>` -> `<x>`, anything
// else (a generic `task`, a blank subagent_type on an older row) -> null.
export function shortName(definition) {
  const d = String(definition ?? "");
  if (d === BASE_DEFINITION) return "default";
  if (d.startsWith(`${BASE_DEFINITION}-`) && d.length > BASE_DEFINITION.length + 1) return d.slice(BASE_DEFINITION.length + 1);
  return null;
}

// Data rows as objects keyed by COLUMNS, plus the raw `line`. A row of any
// width but the legacy or the full one is refused: a tab typed into `note`
// shifts every field after it, and a reader keyed by position cannot tell.
// So is a verdict column holding anything but `yes`, `no` or blank — blank
// because a row backfilled without a ruling leaves both empty, so a row with
// exactly one of the two blank is refused too: it was never written whole, and
// a blanked `closed_own_ticket=no` or `minted_false_claim=yes` would read as a
// pass.
export function parseTierOutcomes(text) {
  return String(text ?? "").split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((line) => {
      const cells = line.split("\t");
      if (cells.length !== LEGACY_WIDTH && cells.length !== COLUMNS.length) {
        throw new Error(`malformed row: ${cells.length} fields, expected ${LEGACY_WIDTH} or ${COLUMNS.length} — ${line.slice(0, 60)}`);
      }
      const row = { line };
      COLUMNS.forEach((c, i) => { row[c] = cells[i] ?? ""; });
      for (const c of VERDICT_COLUMNS) {
        if (row[c] !== "" && !VERDICT.includes(row[c])) {
          throw new Error(`malformed row: ${c} is '${row[c]}', expected yes, no or blank — ${line.slice(0, 60)}`);
        }
      }
      const [first, second] = VERDICT_COLUMNS;
      if ((row[first] === "") !== (row[second] === "")) {
        throw new Error(`malformed row: ${first} is '${row[first]}' but ${second} is '${row[second]}', expected both blank or both yes or no — ${line.slice(0, 60)}`);
      }
      return row;
    });
}

export function formatRow(fields) {
  return COLUMNS.map((c) => String(fields[c] ?? "")).join("\t");
}

// Each ticket's ruling rows of parsed tier-outcomes `rows`, in file order. A
// `+`-joined `ticket` field rules each ticket it names; a row with both
// verdict columns blank was never ruled, so it is skipped.
export function rulingsByTicket(rows) {
  const by = new Map();
  for (const r of rows) {
    if (VERDICT_COLUMNS.every((c) => r[c] === "")) continue;
    for (const t of String(r.ticket ?? "").split("+").filter(Boolean)) (by.get(t) ?? by.set(t, []).get(t)).push(r);
  }
  return by;
}

// Each ticket's last Pull of `pulls` (ticket-features.tsv rows), the whole row,
// in file order: its `run_date` is the floor its ruling must clear.
export function lastPullByTicket(pulls) {
  return new Map(pulls.map((p) => [p.ticket, p]));
}

// A ruling row `rulingFor` refuses, as opposed to a bug in `rulingFor` itself:
// a caller that reports bad input catches this class alone.
export class RulingError extends Error {}

// The row ruling `ticket`'s Pull dated `pullDate`, from `rulingsByTicket`: its
// last ruling in file order dated on or after the Pull, since a ruling never
// predates the Pull it rules — or null. Throws a `RulingError` on any ruling of
// the ticket, picked or not, whose `run_date` is not YYYY-MM-DD, which cannot be
// placed against the Pull and whose drop would uncount the ticket, or which
// holds anything but `yes` or `no` in a verdict column, which would otherwise
// read as a pass.
export function rulingFor(rulings, ticket, pullDate) {
  const own = rulings.get(String(ticket)) ?? [];
  for (const r of own) {
    if (!DATE.test(r.run_date)) throw new RulingError(`ticket #${ticket} (PR #${r.pr}): run_date is '${r.run_date}', expected YYYY-MM-DD`);
    for (const c of VERDICT_COLUMNS) {
      if (!VERDICT.includes(r[c])) throw new RulingError(`ticket #${ticket} (PR #${r.pr}): ${c} is '${r[c]}', expected yes or no`);
    }
  }
  return own.findLast((r) => r.run_date >= pullDate) ?? null;
}

// Every member-outcomes.tsv row for the ticket's implementer, of ANY agent
// type: a lone `task` row is still the ticket's one implementer, and the
// point of the check is to catch exactly that.
export function implementerRows(memberRows, ticket) {
  return memberRows.filter((r) => r.role === "implementer" && r.ticket === String(ticket));
}

// tier-check.mjs's verdict tokens on a ledger row, restricted to this
// ticket's implementers. Only the two that say what ran: a
// `tier-unverifiable=` member settled with no transcript to check, so it
// matches neither kind here and resolves as having no ledger verdict — the
// fallback order below decides it, and it is never read as `tier-ok`.
const TIER_VERDICT = /^tier-(ok|mismatch)=([^:\s]+):(\S+)$/;

// A `{tier, source}` on success or `{tier: "", warning}` when the tier must
// stay blank — built ONLY through these two constructors, so a return site
// cannot pair a non-empty tier with a warning, or the reverse, by drifting
// out of convention (four independent literal object constructions used to
// enforce this by hand across tierFromLedger and tierFromMembers).
const ok = (tier, source) => ({ tier, source, warning: null });
const blocked = (warning) => ({ tier: "", source: null, warning });

// Step 1. Returns `ok(...)`, `blocked(...)` on a recorded mismatch, or null
// to fall through to member-outcomes.tsv. The implementer whose settled
// outcome is `PR#<pr>` owns the verdict when the ledger says who that is;
// otherwise the row must carry verdicts for exactly one member. A mismatch is
// read from EITHER of two ledger shapes: the free-text `tier-mismatch=impl-
// <N>:<definition>` token tier-check.mjs writes when the member is already
// settled some other way, or the member's own settled outcome
// `impl-<N>=tier-mismatch` — tier-check.mjs's main path, a mismatch caught
// while the member is still live, writes only that settled outcome and no
// free-text token (tier-check.mjs's recordImplementer).
export function tierFromLedger(ledger, ticket, pr) {
  const text = rowText(ledger ?? {}, ticket);
  if (!text) return null;
  const ours = (name) => {
    const m = parseMember(name);
    return m?.family === "impl" && m.number === Number(ticket);
  };
  const tokens = [...(ledger.dispatched ?? []).map(parseToken), ...memberTokens(text)].filter((t) => t && ours(t.name));

  const verdicts = [
    ...text.split(/\s+/)
      .map((t) => TIER_VERDICT.exec(t))
      .filter(Boolean)
      .map((m) => ({ kind: m[1], member: m[2], definition: m[3] }))
      .filter((v) => ours(v.member)),
    ...tokens.filter((t) => t.outcome === "tier-mismatch").map((t) => ({ kind: "mismatch", member: t.name, definition: null })),
  ];
  if (verdicts.length === 0) return null;

  const owners = new Set(tokens.filter((t) => t.outcome === `PR#${pr}`).map((t) => t.name));
  // A member settled to anything else terminal (released, bailed, blocked, killed) is
  // positive evidence it did NOT open this PR, so its stale tier-ok verdict
  // never wins the no-owner fallback below — but `tier-mismatch` itself is
  // exempt: that outcome IS the mismatch verdict this function reports, not
  // evidence of a different owner.
  const disqualified = new Set(tokens.filter((t) => t.outcome !== null && t.outcome !== `PR#${pr}` && t.outcome !== "tier-mismatch").map((t) => t.name));
  const mine = owners.size === 1 ? verdicts.filter((v) => owners.has(v.member)) : verdicts.filter((v) => !disqualified.has(v.member));
  const members = new Set(mine.map((v) => v.member));
  if (members.size !== 1) return null;
  const [member] = members;

  const mismatch = mine.find((v) => v.kind === "mismatch");
  if (mismatch) {
    return blocked(mismatch.definition
      ? `the ledger records tier-mismatch=${member}:${mismatch.definition} — it did not run under its definition`
      : `the ledger settled ${member}=tier-mismatch — it did not run under its definition`);
  }
  const definitions = new Set(mine.map((v) => v.definition));
  if (definitions.size !== 1) return null;
  const [definition] = definitions;
  const tier = shortName(definition);
  return tier ? ok(tier, `ledger tier-ok=${member}:${definition}`) : null;
}

// The member did not run a `fleet-implementer*` definition — shared between
// append's WARNING (tierFromMembers) and check's FAIL (checkRows) so the two
// wordings cannot drift apart.
const notADefinition = (m) => `${m.member} ran as ${m.subagentType ? `'${m.subagentType}'` : "no recorded agent type"}, not a ${BASE_DEFINITION}* definition`;

// Step 2, and step 3's reasons.
export function tierFromMembers(memberRows, ticket) {
  const rows = implementerRows(memberRows, ticket);
  if (rows.length === 0) return blocked(`no implementer row for #${ticket} in member-outcomes.tsv`);
  if (rows.length > 1) {
    return blocked(`${rows.length} implementer rows for #${ticket} in member-outcomes.tsv (${rows.map((r) => r.member).join(", ")}) — never tie-broken by run_date`);
  }
  const [row] = rows;
  const tier = shortName(row.subagentType);
  if (!tier) return blocked(notADefinition(row));
  return ok(tier, `member-outcomes.tsv ${row.member} (${row.subagentType})`);
}

export function resolveTier({ ledger, memberRows, ticket, pr }) {
  return tierFromLedger(ledger, ticket, pr) ?? tierFromMembers(memberRows, ticket);
}

// The `sizing` covariate off the ticket's implementer report under `scratch`:
// `{sizing, source, warning: null}`, or `{sizing: "", source: null, warning}`
// naming every condition that failed. The report must check against its
// schema first: a verdict read off a malformed file is not a measurement.
function sizingFromReport(scratch, ticket) {
  const blank = (warning) => ({ sizing: "", source: null, warning });
  const found = latestImplReport(scratch, ticket);
  const report = found === null ? null : readReport(scratch, found.member);
  if (report === null || report.state === "absent") return blank(`no implementer report for ticket #${ticket} under ${reportsDir(scratch)}`);
  if (report.state === "invalid") return blank(`${report.path} does not check against its schema: ${report.violation}`);
  const s = report.report.sizing;
  if (s === null) return blank(`${report.path} carries no sizing (sizing is null)`);
  const failed = [];
  if (s.ranBeforePr !== true) failed.push("sizing.ranBeforePr is not true");
  if (s.signal.trim() === "") failed.push("sizing.signal is empty");
  if (failed.length) return blank(`${report.path}: ${failed.join(" and ")}`);
  return { sizing: s.verdict, source: report.path, warning: null };
}

// `check` over the committed files. Returns failure lines and skip counts.
export function checkRows(rows, memberRows) {
  const failures = [];
  const skipped = { preSwitch: 0, blank: 0, noMemberRow: 0, severalMemberRows: 0 };
  let checked = 0;
  // The filled post-switch rows of each run_date, for the vacuity guard below.
  const byDate = new Map();
  for (const row of rows) {
    if (!DATE.test(row.run_date)) {
      failures.push(`PR #${row.pr}: run_date '${row.run_date}' is not YYYY-MM-DD`);
      continue;
    }
    if (row.run_date < TIER_SWITCH_DATE) { skipped.preSwitch++; continue; }
    if (row.tier === "") { skipped.blank++; continue; }
    const members = implementerRows(memberRows, row.ticket);
    const day = byDate.get(row.run_date) ?? byDate.set(row.run_date, { checked: 0, lost: [] }).get(row.run_date);
    if (members.length === 0) { skipped.noMemberRow++; day.lost.push(`PR #${row.pr} (ticket #${row.ticket})`); continue; }
    if (members.length > 1) { skipped.severalMemberRows++; continue; }
    checked++;
    day.checked++;
    const [m] = members;
    const actual = shortName(m.subagentType);
    if (actual === null) {
      failures.push(`PR #${row.pr} (ticket #${row.ticket}): tier=${row.tier}, but ${notADefinition(m)}`);
    } else if (actual !== row.tier) {
      failures.push(`PR #${row.pr} (ticket #${row.ticket}): tier=${row.tier}, but ${m.member} ran as ${m.subagentType} (${actual})`);
    }
  }
  // `0 checked` is only a pass when nothing was left to compare. The tsv is
  // cumulative, so the whole file's `checked` stays positive once any earlier
  // run was verified: the guard reads the latest run_date alone. When none of
  // that day's filled post-switch rows got a member row compared and some lost
  // their join (a blank ticket there, a stale or absent member file), that run
  // verified nothing. A several-member-rows skip is by design and neither
  // counts as checked nor exempts the lost rows.
  const latest = [...byDate.keys()].sort().at(-1);
  const latestDay = latest === undefined ? null : byDate.get(latest);
  if (latestDay && latestDay.checked === 0 && latestDay.lost.length > 0) {
    failures.push(`nothing from ${latest}, the latest run_date with a filled tier, was checked: no implementer row in the member file for ${latestDay.lost.join(", ")}`);
  }
  return { failures, skipped, checked };
}

// The ledger half of `check`: every PR a run-ledger row marks `reviewed=` that
// has no row here. The row's PR is read the way fleet-tick.mjs reads it —
// ledger-grammar.mjs's rowPr(), else the row's own key.
export function unrecordedReviewedPrs(ledger, rows) {
  const have = new Set(rows.map((r) => r.pr));
  const missing = new Set();
  for (const text of ledger?.rows ?? []) {
    if (!text.split(/\s+/).some((t) => t.startsWith("reviewed="))) continue;
    const key = text.split(/\s/)[0];
    const own = rowPr(text);
    const pr = own !== null ? String(own) : /^#[0-9]+$/.test(key) ? key.slice(1) : null;
    if (pr && !have.has(pr)) missing.add(Number(pr));
  }
  return [...missing].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "usage: tier-outcomes.mjs append <pr> [--note <text>] "
  + "[--sizing light|heavy] [--profile <p>] [--loc <n>] [--files <n>] [--scratch <dir>] [--file <tsv>] [--member-outcomes <tsv>] [--ledger <path>]\n"
  + "       tier-outcomes.mjs append <pr> --closed-own-ticket yes|no --minted-false-claim yes|no --note <text> (a merged PR only) [the same options]\n"
  + "       tier-outcomes.mjs check [--live] [--file <tsv>] [--member-outcomes <tsv>] [--ledger <path>]";

const die = makeDie(NAME);
const APPEND_FLAGS = {
  "closed-own-ticket": "value", "minted-false-claim": "value", note: "value",
  sizing: "value", profile: "value", loc: "value", files: "value", scratch: "value",
};
const FLAGS = { ...APPEND_FLAGS, file: "value", "member-outcomes": "value", ledger: "value", live: "bool" };
const { arg, has, sweep } = defineFlags(die, { flags: FLAGS });

// The positionals — a subcommand and, for `append`, the PR — skipping every
// declared flag's value the way arg.mjs's own stray scan does.
function positionals() {
  const argv = process.argv.slice(2);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (!a.includes("=") && FLAGS[a.slice(2)] === "value") i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch (e) {
    die(`cannot read ${path}: ${e.code ?? e.message}`);
  }
}

function readRows(path) {
  const text = readText(path);
  if (text === null) return { text: null, rows: [] };
  try {
    return { text, rows: parseTierOutcomes(text) };
  } catch (e) {
    die(`${path}: ${e.message}`);
  }
}

function readMemberRows(path) {
  const text = readText(path);
  if (text === null) {
    console.error(`${NAME}: no ${path} — no member rows to read`);
    return [];
  }
  try {
    return parseMemberTsv(text);
  } catch (e) {
    die(`${path}: ${e.message}`);
  }
}

function readLedger(ledgerFile, requireFile) {
  const args = [LEDGER_SCRIPT, ...(ledgerFile ? ["--file", ledgerFile] : []), ...(requireFile ? ["--require-file"] : []), "read"];
  let raw;
  try {
    raw = execFileSync(process.execPath, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    die(`could not read the ledger: ${e.stderr?.trim() || e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`could not read the ledger: ${e.message}`);
  }
}

// `gh pr view <pr> --json <fields>` parsed, or an Error naming why it could
// not be read. GH_REPO is blanked so an ambient one naming another repository
// never decides which PR is read; the timeout keeps a hung `gh` from stalling
// `append` or a close-out's `check --live`.
const GH_TIMEOUT_MS = 60_000;
function ghPrView(pr, fields) {
  let raw;
  try {
    raw = execFileSync("gh", ["pr", "view", String(pr), "--json", fields], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_REPO: "" }, timeout: GH_TIMEOUT_MS,
    });
  } catch (e) {
    throw new Error(`gh pr view ${pr} failed: ${e.stderr?.trim() || e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`gh pr view ${pr} returned unreadable JSON: ${e.message}`);
  }
}

// The unique issue numbers of a PR's closingIssuesReferences in its own
// repository, by ownClosingIssues()'s rule, in GitHub's order — another
// repository's reference is none of them — or an Error naming why they could
// not be read, a reference that rule cannot read among the reasons.
function closingIssueNumbers(pr) {
  const view = ghPrView(pr, "closingIssuesReferences,url");
  if (!Array.isArray(view?.closingIssuesReferences)) throw new Error(`gh pr view ${pr} returned no closingIssuesReferences array`);
  try {
    return ownClosingIssues(pr, view.url, view.closingIssuesReferences);
  } catch (e) {
    throw new Error(`gh pr view ${pr} answered ${e.message}`);
  }
}

function closingNumbers(pr) {
  try {
    return closingIssueNumbers(pr);
  } catch (e) {
    die(e.message);
  }
}

// Every settled `impl-<N>=PR#<pr>` token in the run ledger's rows, each with the
// row that carries it and its ticket N. The dispatched list is not read.
// Exported for ledger.mjs's finisher dispatch, which gates the same PRs.
export function implementerClaims(ledger, pr) {
  const claims = [];
  for (const text of ledger?.rows ?? []) {
    const key = text.split(/\s/)[0];
    for (const t of memberTokens(text)) {
      if (t.family === "impl" && t.error === null && t.outcome === `PR#${pr}`) claims.push({ key, ticket: t.number });
    }
  }
  return claims;
}

// The ticket a PR's row keys on: its one closing issue, else the N of its one
// settled impl token. Otherwise `refusal` says why there is none, and `claims`
// counts the settled impl tokens naming the PR — none is a PR no implementer
// names. Refused: no such token, several, or several closing issues that do not
// include the token's N.
function ticketFor(pr, numbers, ledger) {
  if (numbers.length === 1) return { ticket: String(numbers[0]) };
  const claims = implementerClaims(ledger, pr);
  const closes = numbers.length === 0 ? "closes no issue" : `closes ${numbers.length} issues (${numbers.map((n) => `#${n}`).join(", ")})`;
  const refused = (why) => ({ claims: claims.length, refusal: `PR #${pr} ${closes} per GitHub's closingIssuesReferences, and ${why}` });
  if (claims.length === 0) {
    return refused(`no run-ledger row carries a settled impl-N=PR#${pr} token to name its ticket — a tier-outcomes row keys on exactly one ticket`);
  }
  if (claims.length > 1) {
    return refused(`${claims.length} run-ledger rows carry a settled impl-N=PR#${pr} token (${claims.map((c) => c.key).join(", ")}) — a tier-outcomes row keys on exactly one ticket`);
  }
  const [{ key, ticket }] = claims;
  if (numbers.length > 1 && !numbers.includes(ticket)) {
    return refused(`its settled impl-${ticket}=PR#${pr} token in ${key} names #${ticket}, which is not among them`);
  }
  return { ticket: String(ticket) };
}

// The UTC date, the convention of a session id's date and so of every Pull's
// `run_date` a ruling is joined to.
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// the Ruling worked out from the Charges
// ---------------------------------------------------------------------------

const oneLine = (s) => String(s ?? "").replace(/[\t\r\n]/g, " ");

// `path` parsed as JSON: `{value}`, or `{problem}` naming the failure — with
// `code` the error code when the file could not be read at all, and no `code`
// when it was read and is not valid JSON.
function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { code: e.code, problem: `${path} cannot be read: ${e.code ?? e.message}` };
  }
  try {
    return { value: JSON.parse(text) };
  } catch (e) {
    return { problem: `${path} is not valid JSON: ${e.message}` };
  }
}

// The Charge an entry carries, `{charge, reason}`, or null when it carries
// none a Ruling can read: a value outside CHARGES, or `none` with no reason
// from CHARGE_REASONS.
function chargeOf(e) {
  if (!CHARGES.includes(e.charge)) return null;
  if (e.charge !== "none") return { charge: e.charge, reason: null };
  return CHARGE_REASONS.includes(e.chargeReason) ? { charge: "none", reason: e.chargeReason } : null;
}

// The record file names under `scratch` that answer PR `pr`, as `{file,
// letter}`, highest retry letter first — the first attempt, which carries no
// letter, last. Empty when the directory is not there.
function recordFiles(scratch, pr) {
  let names;
  try {
    names = readdirSync(scratch);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw new Error(`cannot list ${scratch}: ${e.code ?? e.message}`);
  }
  const answering = new RegExp(`^dispositions-fix-pr-${pr}(?:-([a-z]))?\\.json$`);
  return names
    .flatMap((file) => {
      const m = answering.exec(file);
      return m === null ? [] : [{ file, letter: m[1] ?? "" }];
    })
    .sort((a, b) => (a.letter < b.letter ? 1 : a.letter > b.letter ? -1 : 0));
}

// The last record answering review run `run`: `{file, path, value}`, `{missing}`
// naming why there is none, a retry's record replacing the first attempt's on
// the same run and a record answering any other run changing nothing. A file
// met before the answering one that cannot be read, or is not valid JSON,
// names no run, so it could be the retry's: it refuses rather than letting an
// older record stand in.
function recordFor(scratch, pr, run) {
  let files;
  try {
    files = recordFiles(scratch, pr);
  } catch (e) {
    return { missing: e.message };
  }
  for (const { file } of files) {
    const path = join(scratch, file);
    const read = readJson(path);
    if (read.problem !== undefined) return { missing: read.problem };
    if (read.value?.run === run) return { file, path, value: read.value };
  }
  return { missing: `no ${join(scratch, `dispositions-fix-pr-${pr}[-x].json`)} names review ${run} as the run it answers` };
}

// The Charges `record` carries on the findings of `review` that stand, as the
// pieces of the note and the findings with none. A survived finding no entry
// answers stands, with no Charge. `broken` names each entry the Ruling cannot
// read — not an object, a bucket the review has not got, an index naming no
// finding, or a second entry for a finding an earlier one answers — since
// skipping one could hide the Charge that decides a column.
function chargesOf(review, record) {
  const entries = new Map();
  const broken = [];
  for (const [n, e] of (Array.isArray(record.entries) ? record.entries : []).entries()) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      broken.push(`entries[${n}] is not an object`);
      continue;
    }
    if (!["survived", "refuted", "unverified"].includes(e.bucket)) {
      broken.push(`entries[${n}] names bucket ${JSON.stringify(e.bucket ?? null)}, not survived, refuted or unverified`);
      continue;
    }
    if (!Number.isInteger(e.index) || e.index < 0 || e.index >= review[e.bucket].length) {
      broken.push(`entries[${n}] names ${e.bucket}[${JSON.stringify(e.index ?? null)}], and ${e.bucket} holds ${review[e.bucket].length}`);
      continue;
    }
    const key = `${e.bucket}[${e.index}]`;
    if (entries.has(key)) broken.push(`entries[${n}] is a second entry for ${key}, which entries[${entries.get(key).n}] already answers`);
    else entries.set(key, { e, n });
  }
  const entryFor = (key) => entries.get(key)?.e;
  const out = { charged: [], none: [], cleared: [], missing: [], broken };
  const take = (bucket, index, e) => {
    const key = `${bucket}[${index}]`;
    const c = e === undefined ? null : chargeOf(e);
    if (c === null) out.missing.push(`${key} "${oneLine(review[bucket][index].claim)}"`);
    else if (c.charge === "none") out.none.push(`${key} ${c.reason}`);
    else out.charged.push({ charge: c.charge, text: `${key} ${c.charge} "${oneLine(review[bucket][index].claim)}"` });
  };
  review.survived.forEach((_, index) => {
    const e = entryFor(`survived[${index}]`);
    if (e !== undefined && !stands("survived", e)) out.cleared.push(`survived[${index}] ${e.reason}`);
    else take("survived", index, e);
  });
  review.refuted.forEach((_, index) => {
    const e = entryFor(`refuted[${index}]`);
    if (e !== undefined) take("refuted", index, e);
  });
  return out;
}

const FAILS_CLOSED = ["unmet", "both"];
const MINTS = ["false-claim", "both"];

// The Ruling of a first review, pure: `{closed_own_ticket, minted_false_claim,
// note}`, or `{missing}` saying what is not there to read. `run` and `head` are
// the ledger token's; `review` is the findings as `review.json` holds them
// (`survived`, `refuted`, `unverified`, `dimensionsUnrun`), assumed well-formed
// as reviewProblem guarantees. `record` is called, at most once, only when a
// survived or unverified finding needs a record: it returns `{file, path,
// value}` or `{missing}`. Reads no file and runs no command.
export function deriveRuling({ run, head, review, record }) {
  // An entry that is neither a dimension's name nor {dimension} is named as
  // the JSON it is, so the note never reads as a blank dimension.
  const unrun = (Array.isArray(review.dimensionsUnrun) ? review.dimensionsUnrun : []).map((d) => oneLine(
    typeof d === "string" ? d : typeof d?.dimension === "string" ? d.dimension : JSON.stringify(d ?? null),
  ));
  const opening = `review ${run} at ${head.slice(0, 7)}`;
  const noted = (parts) => (unrun.length === 0 ? parts : [...parts, `unrun: ${unrun.join(", ")}`]).join("; ");

  if (review.survived.length === 0 && review.unverified.length === 0) {
    return { closed_own_ticket: "yes", minted_false_claim: "no", note: `${opening}, no record: ${noted(["counted no survived and no unverified finding"])}` };
  }
  const found = record();
  if (found.missing !== undefined) return { missing: found.missing };
  const charges = chargesOf(review, found.value);
  if (charges.broken.length > 0) {
    return { missing: `${found.path} has ${charges.broken.length === 1 ? "an entry" : "entries"} a Ruling cannot read: ${charges.broken.join("; ")}` };
  }
  if (charges.missing.length > 0) {
    return { missing: `${found.path} carries no Charge on ${charges.missing.length === 1 ? "this standing finding" : "these standing findings"}: ${charges.missing.join("; ")}` };
  }
  const parts = charges.charged.map((c) => c.text);
  if (charges.none.length > 0) parts.push(`none: ${charges.none.join(", ")}`);
  if (charges.cleared.length > 0) parts.push(`cleared: ${charges.cleared.join(", ")}`);
  return {
    closed_own_ticket: charges.charged.some((c) => FAILS_CLOSED.includes(c.charge)) ? "no" : "yes",
    minted_false_claim: charges.charged.some((c) => MINTS.includes(c.charge)) ? "yes" : "no",
    note: `${opening}, record ${found.file}: ${noted(parts.length === 0 ? ["no finding stands"] : parts)}`,
  };
}

// PR `pr`'s first review read from scratch and tied to the ledger, then ruled
// by deriveRuling: its Ruling plus `review`, the review's run, or `{missing}`
// saying what is not there to read. `scratch` is `{root}` or `{unresolvable}`.
function scratchRuling(pr, ledger, scratch) {
  const review = firstReview(prTokens(ledger?.rows ?? [], Number(pr)));
  if (review === null) {
    return { missing: `PR #${pr} has no first review on the ledger: no \`reviewed=\` token of its rows counted no survived and no unverified finding, or was answered by a fix-applier` };
  }
  if (scratch.unresolvable !== undefined) return { missing: `no scratch root to look in: ${scratch.unresolvable}` };
  const reviewPath = join(scratch.root, `pr${pr}`, review.run, "review.json");
  const read = readJson(reviewPath);
  if (read.code === "ENOENT") return { missing: `review ${review.run}'s result file ${reviewPath} is missing` };
  if (read.problem !== undefined) return { missing: read.problem };
  const file = read.value;
  const problem = reviewProblem(file);
  if (problem !== null) return { missing: `${reviewPath} ${problem}` };
  if (!sameHead(String(file.head).toLowerCase(), review.head)) {
    return { missing: `${reviewPath} is the review of head ${file.head}, not the ledger's review ${review.run} at ${review.head}` };
  }
  if (file.survived.length !== review.survived || file.unverified.length !== review.unverified) {
    return { missing: `${reviewPath} holds ${file.survived.length} survived and ${file.unverified.length} unverified, not the ${review.survived} and ${review.unverified} the ledger's review ${review.run} counted` };
  }
  return { ...deriveRuling({ run: review.run, head: review.head, review: file, record: () => recordFor(scratch.root, pr, review.run) }), review: review.run };
}

// The step a refusal hands the controller. A merged PR's evidence is
// reclaimed with its scratch, so the verdicts are given by hand; any other
// PR's is still wanted, and a ruling is never typed for it.
function nextStep(pr, state) {
  if (state === "MERGED") {
    return `the PR is merged and its evidence is not there to read — give the verdicts by hand: append ${pr} --closed-own-ticket yes|no --minted-false-claim yes|no --note "<the evidence>"`;
  }
  return `check the record again (\`dispositions-check.mjs --member fix-pr-${pr} --scratch <scratch>\`), or dispatch the fix-applier again as a dispositions retry (\`--kind dispositions-retry\`), then run append ${pr} again`;
}

// The PR's state as GitHub gives it: OPEN, CLOSED (never merged) or MERGED.
function prState(pr) {
  const view = ghPrView(pr, "state");
  if (!["OPEN", "CLOSED", "MERGED"].includes(view?.state)) {
    throw new Error(`gh pr view ${pr} returned state ${JSON.stringify(view?.state ?? null)}, not OPEN, CLOSED or MERGED`);
  }
  return view.state;
}

function append(pr, paths) {
  if (!isDigits(pr) || Number(pr) === 0) die(`append needs a PR number, got '${pr}'`);
  pr = String(Number(pr));
  if (has("live")) die("--live is a check flag");
  const sizingFlag = arg("sizing");
  const fields = {
    closed_own_ticket: arg("closed-own-ticket"), minted_false_claim: arg("minted-false-claim"),
    note: arg("note"), sizing: sizingFlag ?? "", profile: arg("profile") ?? "", loc: arg("loc") ?? "", files: arg("files") ?? "",
  };
  const given = VERDICT_COLUMNS.filter((col) => fields[col] !== null);
  if (given.length === 1) die(`--${given[0].replaceAll("_", "-")} comes with ${VERDICT_COLUMNS.filter((c) => c !== given[0]).map((c) => `--${c.replaceAll("_", "-")}`)} or not at all\n${USAGE}`);
  const byHand = given.length > 0;
  if (byHand && fields.note === null) die(`verdicts given by hand need --note, naming the evidence for them\n${USAGE}`);
  for (const [col, value] of Object.entries(fields)) {
    if (value !== null && /[\t\r\n]/.test(value)) die(`--${col.replaceAll("_", "-")} holds a tab or newline — it would shift every field after it`);
  }
  if (byHand) {
    for (const col of VERDICT_COLUMNS) {
      if (!VERDICT.includes(fields[col])) die(`--${col.replaceAll("_", "-")} must be yes or no, got '${fields[col]}'`);
    }
  }
  if (fields.sizing && !["light", "heavy"].includes(fields.sizing)) die(`--sizing must be light or heavy, got '${fields.sizing}'`);
  for (const col of ["loc", "files"]) {
    if (fields[col] && !isDigits(fields[col])) die(`--${col} must be a count, got '${fields[col]}'`);
  }

  const { text, rows } = readRows(paths.file);
  const existing = rows.find((r) => r.pr === pr);
  if (existing) {
    console.log(`${NAME}: PR #${pr} already has a row in ${paths.file} — nothing appended:\n${existing.line}`);
    return;
  }

  let scratch = { root: paths.scratch };
  if (scratch.root === null) {
    try {
      scratch = { root: defaultScratch() };
    } catch (e) {
      if (!(e instanceof FleetDirUnresolvable)) throw e;
      scratch = { unresolvable: e.message };
    }
  }

  const ledger = readLedger(paths.ledger, false);
  if (byHand) {
    let state;
    try {
      state = prState(pr);
    } catch (e) {
      die(`could not read PR #${pr}'s state, which decides whether verdicts may be given by hand: ${e.message}`);
    }
    if (state !== "MERGED") {
      die(`PR #${pr} is ${state === "OPEN" ? "open" : "closed without merging"}, and verdicts are given by hand only for a merged PR — leave out --closed-own-ticket and --minted-false-claim, and \`append\` works them out from the record: ${nextStep(pr, state)}`);
    }
  } else {
    const ruled = scratchRuling(pr, ledger, scratch);
    if (ruled.missing !== undefined) {
      let state = null;
      let unread = "";
      try {
        state = prState(pr);
      } catch (e) {
        unread = ` (the PR's state could not be read: ${e.message})`;
      }
      die(`cannot rule PR #${pr} from its record — ${ruled.missing}${unread}; ${nextStep(pr, state)}`);
    }
    fields.closed_own_ticket = ruled.closed_own_ticket;
    fields.minted_false_claim = ruled.minted_false_claim;
    fields.note = fields.note === null ? ruled.note : `${ruled.note} — ${fields.note}`;
    console.error(`${NAME}: closed_own_ticket=${fields.closed_own_ticket} minted_false_claim=${fields.minted_false_claim} from the Charges on review ${ruled.review}`);
  }

  const { ticket, refusal } = ticketFor(pr, closingNumbers(pr), ledger);
  if (refusal) die(refusal);
  const memberRows = readMemberRows(paths.members);
  const resolved = resolveTier({ ledger, memberRows, ticket, pr });
  if (resolved.warning) console.error(`${NAME}: WARNING tier left blank for PR #${pr} (ticket #${ticket}): ${resolved.warning}`);
  else console.error(`${NAME}: tier=${resolved.tier} from ${resolved.source}`);

  if (sizingFlag !== null) {
    console.error(`${NAME}: sizing=${fields.sizing} from --sizing`);
  } else {
    const sized = scratch.unresolvable === undefined ? sizingFromReport(scratch.root, ticket) : { sizing: "", source: null, warning: `no scratch root to look in: ${scratch.unresolvable}` };
    fields.sizing = sized.sizing;
    if (sized.warning) console.error(`${NAME}: WARNING sizing left blank for PR #${pr} (ticket #${ticket}): ${sized.warning}`);
    else console.error(`${NAME}: sizing=${sized.sizing} from ${sized.source}`);
  }

  const line = formatRow({ ...fields, run_date: today(), pr, ticket, tier: resolved.tier });
  if (text === null) writeFileSync(paths.file, `# ${COLUMNS.join("\t")}\n${line}\n`);
  else appendFileSync(paths.file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
  console.log(line);
}

// A PR's closing issue numbers, or null after a line naming why they could not
// be read. That line never reads `WARNING PR #`, which closeout.mjs turns into
// a NEED; a PR whose read failed keeps its warning.
function closingNumbersOrNull(pr) {
  try {
    return closingIssueNumbers(pr);
  } catch (e) {
    console.error(`${NAME}: could not read the closing references of PR #${pr}: ${e.message}`);
    return null;
  }
}

function check(paths) {
  for (const flag of Object.keys(APPEND_FLAGS)) {
    if (arg(flag) !== null) die(`--${flag} is an append flag`);
  }
  const { text, rows } = readRows(paths.file);
  if (text === null) die(`no ${paths.file} — no rows to check`);
  const memberRows = readMemberRows(paths.members);
  const { failures, skipped, checked } = checkRows(rows, memberRows);

  if (has("live")) {
    const ledger = readLedger(paths.ledger, true);
    for (const pr of unrecordedReviewedPrs(ledger, rows)) {
      const numbers = closingNumbersOrNull(pr);
      const { refusal, claims } = numbers === null ? {} : ticketFor(pr, numbers, ledger);
      if (refusal && claims === 0) {
        const closes = numbers.length === 0 ? "closes no issue" : `closes ${numbers.length} issues`;
        console.error(`${NAME}: note PR #${pr} carries reviewed= on the ledger and ${closes}, and no settled impl token names it, so it takes no row in ${paths.file}`);
        continue;
      }
      const next = refusal ? `\`tier-outcomes.mjs append ${pr}\` refuses it: ${refusal}` : `run \`tier-outcomes.mjs append ${pr}\` if it is an implementer PR`;
      console.error(`${NAME}: WARNING PR #${pr} carries reviewed= on the ledger but has no row in ${paths.file} — ${next}`);
    }
  }

  for (const f of failures) console.error(`${NAME}: FAIL ${f}`);
  console.log(`${NAME}: ${rows.length} rows; ${checked} checked, ${failures.length} failed; skipped ${skipped.preSwitch} before ${TIER_SWITCH_DATE}, `
    + `${skipped.blank} blank, ${skipped.noMemberRow} with no member row, ${skipped.severalMemberRows} with several member rows`);
  process.exit(failures.length ? 1 : 0);
}

function main() {
  const paths = {
    file: arg("file") ?? "docs/metrics/tier-outcomes.tsv",
    members: arg("member-outcomes") ?? "docs/metrics/member-outcomes.tsv",
    ledger: arg("ledger"),
    scratch: arg("scratch"),
  };
  // Below every flag read, per arg.mjs's ordering contract, and above the
  // subcommand checks, so a stray flag is refused by name before anything
  // reads a file or asks gh.
  sweep();
  const [cmd, ...rest] = positionals();
  if (cmd === "append") {
    if (rest.length !== 1) die(`append takes exactly one PR number\n${USAGE}`);
    append(rest[0], paths);
  } else if (cmd === "check") {
    if (rest.length) die(`check takes no positional, got '${rest[0]}'\n${USAGE}`);
    check(paths);
  } else {
    die(cmd ? `unknown subcommand '${cmd}'\n${USAGE}` : USAGE);
  }
}

if (isCLI(import.meta.url)) main();
