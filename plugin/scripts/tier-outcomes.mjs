#!/usr/bin/env node
// Writer and checker for docs/metrics/tier-outcomes.tsv (#2207, split off
// #1398). The `tier` column used to be typed by hand from what the controller
// MEANT to dispatch and was never compared with what ran: #1445 and #1446 say
// `opus` for two implementers dispatched as a generic `task` that ran
// sonnet/high, which is neither tier arm.
//
//   append <pr> --closed-own-ticket yes|no --minted-false-claim yes|no
//          --note <text> [--sizing light|heavy] [--profile <p>] [--loc <n>] [--files <n>]
//     Fills `run_date` (today, the ruling date), `pr`, `ticket` (off
//     `gh pr view --json closingIssuesReferences`) and `tier`. Idempotent by
//     PR: a row already present is named and nothing is written, exit 0.
//   check [--live]
//     Post-switch rows only: a filled `tier` must equal the short name of the
//     ticket's single implementer row in member-outcomes.tsv, and that row
//     must be a `fleet-implementer*` definition — exit 1 otherwise, and exit 1
//     when none of the latest run_date's filled rows could be compared and some
//     lack a member row (nothing from that run was checked). `--live`
//     (a run in progress; CI never passes it) adds a WARNING, never a
//     failure, per PR whose run-ledger row carries `reviewed=` but which has
//     no row here. `--ledger <path>` names another ledger than the run's own.
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
// Values are definition SHORT NAMES (ADR 0011: never a vendor family):
// `fleet-implementer` is `default`, `fleet-implementer-<x>` is `<x>` (`alt`,
// or a #2030 per-cell name). Rows dated before TIER_SWITCH_DATE hold the old
// `opus`/`sonnet` spelling and are never checked; the header records the
// switch and how the old values map.
//
// Exit codes: 0 ok, 1 `check` found a mismatch or checked nothing from the latest
// run_date (see `check`), 2 usage or unreadable input.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isCLI } from "./is-cli.mjs";
import { makeDie, defineFlags, isDigits } from "./arg.mjs";
import { parseTsv as parseMemberTsv } from "./member-outcomes.mjs";
import { parseMember, parseToken, memberTokens } from "./ledger-grammar.mjs";
import { rowText } from "./tier-check.mjs";
import { PR_MENTION } from "./fleet-tick.mjs";

const NAME = "tier-outcomes";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEDGER_SCRIPT = join(SCRIPT_DIR, "ledger.mjs");

// ---------------------------------------------------------------------------
// pure core — exercised through the CLI by tier-outcomes.test.mjs; only
// COLUMNS and TIER_SWITCH_DATE are imported directly, the rest through argv
// ---------------------------------------------------------------------------

// APPENDED TO, never inserted into: every awk read-out in the file's header
// and in run-team/SKILL.md indexes by position.
export const COLUMNS = Object.freeze([
  "run_date", "pr", "ticket", "class", "tier", "closed_own_ticket",
  "minted_false_claim", "note", "sizing", "profile", "loc", "files",
]);
// Rows predating the four difficulty covariates are SHORT on purpose.
export const LEGACY_WIDTH = COLUMNS.length - 4;

// The first `run_date` whose `tier` is a definition short name. Also the
// date of the header's switch note.
export const TIER_SWITCH_DATE = "2026-09-29";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASE_DEFINITION = "fleet-implementer";
// The two quality-floor columns `append` writes. Every reader fails the floor
// on exactly `minted_false_claim=yes` or `closed_own_ticket=no`, so any other
// spelling would read as a pass.
export const VERDICT = Object.freeze(["yes", "no"]);
const VERDICT_COLUMNS = Object.freeze(["closed_own_ticket", "minted_false_claim"]);

// `fleet-implementer` -> `default`, `fleet-implementer-<x>` -> `<x>`, anything
// else (a generic `task`, a blank pre-#1066 subagent_type) -> null.
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
// because a row backfilled without a ruling leaves both empty.
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
      return row;
    });
}

export function formatRow(fields) {
  return COLUMNS.map((c) => String(fields[c] ?? "")).join("\t");
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
  // A member settled to anything else terminal (released, bailed, killed) is
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
// has no row here. The row's PR is read the way fleet-tick.mjs reads it — a
// `PR#M` mention, else the row's own key.
export function unrecordedReviewedPrs(ledger, rows) {
  const have = new Set(rows.map((r) => r.pr));
  const missing = new Set();
  for (const text of ledger?.rows ?? []) {
    if (!text.split(/\s+/).some((t) => t.startsWith("reviewed="))) continue;
    const key = text.split(/\s/)[0];
    const mention = PR_MENTION.exec(text);
    const pr = mention ? mention[1] : /^#[0-9]+$/.test(key) ? key.slice(1) : null;
    if (pr && !have.has(pr)) missing.add(Number(pr));
  }
  return [...missing].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = "usage: tier-outcomes.mjs append <pr> --closed-own-ticket yes|no --minted-false-claim yes|no --note <text> "
  + "[--sizing light|heavy] [--profile <p>] [--loc <n>] [--files <n>] [--file <tsv>] [--member-outcomes <tsv>] [--ledger <path>]\n"
  + "       tier-outcomes.mjs check [--live] [--file <tsv>] [--member-outcomes <tsv>] [--ledger <path>]";

const die = makeDie(NAME);
const APPEND_FLAGS = {
  "closed-own-ticket": "value", "minted-false-claim": "value", note: "value",
  sizing: "value", profile: "value", loc: "value", files: "value",
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

function closingTicket(pr) {
  let raw;
  try {
    raw = execFileSync("gh", ["pr", "view", pr, "--json", "closingIssuesReferences"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    die(`gh pr view ${pr} failed: ${e.stderr?.trim() || e.message}`);
  }
  let refs;
  try {
    refs = JSON.parse(raw).closingIssuesReferences;
  } catch (e) {
    die(`gh pr view ${pr} returned unreadable JSON: ${e.message}`);
  }
  if (!Array.isArray(refs)) die(`gh pr view ${pr} returned no closingIssuesReferences array`);
  const numbers = [...new Set(refs.map((r) => r?.number))];
  if (numbers.length !== 1 || !Number.isInteger(numbers[0])) {
    die(`PR #${pr} closes ${numbers.length === 0 ? "no issue" : `${numbers.length} issues (${numbers.map((n) => `#${n}`).join(", ")})`} per GitHub's closingIssuesReferences — a tier-outcomes row keys on exactly one ticket`);
  }
  return String(numbers[0]);
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function append(pr, paths) {
  if (!isDigits(pr) || Number(pr) === 0) die(`append needs a PR number, got '${pr}'`);
  pr = String(Number(pr));
  if (has("live")) die("--live is a check flag");
  const fields = {
    closed_own_ticket: arg("closed-own-ticket"), minted_false_claim: arg("minted-false-claim"),
    note: arg("note"), sizing: arg("sizing") ?? "", profile: arg("profile") ?? "", loc: arg("loc") ?? "", files: arg("files") ?? "",
  };
  for (const col of ["closed_own_ticket", "minted_false_claim", "note"]) {
    if (fields[col] === null) die(`append needs --${col.replaceAll("_", "-")}\n${USAGE}`);
  }
  for (const [col, value] of Object.entries(fields)) {
    if (/[\t\r\n]/.test(value)) die(`--${col.replaceAll("_", "-")} holds a tab or newline — it would shift every field after it`);
  }
  for (const col of VERDICT_COLUMNS) {
    if (!VERDICT.includes(fields[col])) die(`--${col.replaceAll("_", "-")} must be yes or no, got '${fields[col]}'`);
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

  const ticket = closingTicket(pr);
  const ledger = readLedger(paths.ledger, false);
  const memberRows = readMemberRows(paths.members);
  const resolved = resolveTier({ ledger, memberRows, ticket, pr });
  if (resolved.warning) console.error(`${NAME}: WARNING tier left blank for PR #${pr} (ticket #${ticket}): ${resolved.warning}`);
  else console.error(`${NAME}: tier=${resolved.tier} from ${resolved.source}`);

  const line = formatRow({ ...fields, run_date: today(), pr, ticket, tier: resolved.tier });
  if (text === null) writeFileSync(paths.file, `# ${COLUMNS.join("\t")}\n${line}\n`);
  else appendFileSync(paths.file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
  console.log(line);
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
      console.error(`${NAME}: WARNING PR #${pr} carries reviewed= on the ledger but has no row in ${paths.file} — run \`tier-outcomes.mjs append ${pr}\` if it is an implementer PR`);
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
