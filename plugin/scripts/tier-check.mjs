#!/usr/bin/env node
// The dispatch-time tier check (#1345, ruled on #1298; ADR 0014). Layer 2 of
// two: layer 1 (#1314) is a static audit of the agent files' SHAPE, before
// any run exists; this layer compares what a run actually DISPATCHED against
// what omp's own record says it RESOLVED, for every member dispatched by
// named definition. Not a lint — a refusal, run after every Pull's dispatch,
// whose verdict on an implementer lands on the ledger, where fleet-tick.mjs
// holds the next Pull until there is one (run-team/SKILL.md's phase 2).
//
// Declared is the definition's own frontmatter — `model: "@<role>:<level>"`,
// a fleet tier route (ADR 0014), never a vendor id. Resolved is read back
// from omp's own record, three ways, in preference order:
//   1. the job record's OWN `resolvedModel`/`resolvedThinkingLevel` (#1302)
//      — a controller that already holds BOTH never opens the child's file
//      at all (this ticket's 4th fixture). Holding only one is the ordinary
//      case, not a corner (the two live on different omp records), so the
//      missing half is read off the transcript instead of reported as a lie.
//   2. `--session <dir>` — the controller's own session root, when it has no
//      job record (or only half of one) but knows where its dispatched
//      member's own transcript lives: the flat `<session>/<member>.jsonl`
//      file, read directly (#1345's extension to member-record.mjs's
//      readers — a member with no assistant turn yet still resolves off its
//      dispatch-time `session_init` record, never treated as absent).
//   3. `--transcript <file>` — the member's own transcript, when the caller
//      already holds the exact path (tests, or a caller with no session
//      root handy).
//
// Compare is EXACT on the level (`thinking-level` verbatim) and by ROLE
// TARGET on the model: the declared alias's role (`@slow`/`@task`/`@smol`)
// resolves through the operator's `modelRoles.<role>`, and the resolved
// identity is compared against THAT target (`expectedOmpModel`) — never
// against the alias's own spelling, which would let an unrelated role
// resolving to a same-family model pass by accident. Real spellings carry
// more than the bare family name — `resolvedModel`/`resolvedModelIdentity`
// are ALWAYS provider-prefixed (`anthropic/claude-opus-5`,
// `anthropic/claude-opus-5:high` — 906/906 measured, zero bare) — so
// `modelsEqual` (tier-roles.mjs) strips the provider prefix and any
// `:suffix` tail before matching.
//
// A batch file, not one member: `--batch` takes a JSON array, and the
// failure line — `member: declared <m>/<l> resolved <m>/<l>` — is printed
// once per member that mismatched, not once per invocation. Under Pull,
// run-team's phase 2 calls this after every Pull's dispatch with a batch of
// one, the member just dispatched. See run-team/SKILL.md's phase-2 dispatch
// paragraph for the batch file's exact entry shape and how the controller
// obtains each field.
//
// An implementer (`impl-<N>`, ledger-grammar.mjs's name) is judged on the
// ledger's terms, not the caller's (#1398): the definition it should have
// run under is derived from its ticket row's `tier=` token
// (ledger-grammar.mjs's `expectedDefinition` — the same function
// `ledger.mjs dispatch` prints the definition from, #2208), the agent type
// it was actually dispatched as is
// read off its own transcript and must BE that definition — a generic `task`
// dispatch fails even when its model happens to match — and the verdict
// lands on the ledger either way: `tier-ok=impl-<N>:<definition>` on the
// row on a pass, `ledger.mjs settle impl-<N> tier-mismatch` on a failure.
// fleet-tick.mjs holds the next Pull on the newest implementer of a ticket
// carrying neither.
//
// Exit status: 0 every member passed; 1 any member mismatched; 2 usage — a
// bad batch, flag or config, an unreadable ledger, or a member whose
// transcript cannot be found, before anything is written; 3 no mismatch, but
// at least one implementer was recorded `tier-unverifiable=impl-<N>:no-transcript`
// — settled anywhere on the ledger (a row or `## Dispatched`) while its
// `session` names an existing directory holding no `<member>.jsonl`, the
// trace of a dispatch that failed before a transcript was written. That token
// clears the tick's unchecked hold without claiming the tier was right. A
// LIVE member with no transcript is still exit 2: it may yet write one, and
// a `session` that is omitted, empty, missing or not a directory is exit 2
// whether the member is live or settled.

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeDie, defineFlags } from "./arg.mjs";
import { foldOmpTranscript, parseMemberName } from "./member-record.mjs";
import { parseFrontmatter, expectedOmpModel, modelsEqual, readOmpConfigValue } from "./tier-roles.mjs";
import { parseMember, parseToken, memberTokens, expectedDefinition } from "./ledger-grammar.mjs";

const NAME = "tier-check";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEDGER_SCRIPT = join(SCRIPT_DIR, "ledger.mjs");

// ---------------------------------------------------------------------------
// pure core — unit-tested directly (tier-check.test.mjs), no filesystem or
// process access below this line until main()
// ---------------------------------------------------------------------------

// The declared pair a dispatch is judged against — straight off the
// definition's own frontmatter (`tier-roles.mjs`'s `parseFrontmatter`
// already carries `model`/`level`, never a second reader here).
export function declaredPairFor(frontmatter) {
  return { model: frontmatter.model, level: frontmatter.level };
}

// The resolved pair off a transcript (or the omp job record). The
// short-circuit requires BOTH `resolvedModel` AND `resolvedThinkingLevel` —
// they live on different omp records (`session_init` carries
// `resolvedModel`/`resolvedModelIdentity`, `thinking_level_change` carries
// `thinkingLevel`; no single line carries both, measured 906 of the former
// against 232 of the latter), so holding only one is the ORDINARY case, not
// a corner, and the missing half is read off the transcript rather than
// reported as `null` (a `null` reaching `formatMismatch` would print
// `resolved .../null`, a lie about a field nobody asked was absent).
//
// The transcript-derived model prefers `resolvedModelIdentity`
// (`session_init`, written at DISPATCH) over the assistant turn's own
// `model`: the identity exists before the member's first turn, where the
// per-turn model does not, so preferring it is what makes this check usable
// immediately after a background dispatch rather than only once a member has
// already produced output.
export function resolveActual({ transcriptText, resolvedModel, resolvedThinkingLevel }) {
  if (resolvedModel && resolvedThinkingLevel) {
    return { model: resolvedModel, level: resolvedThinkingLevel, viaJobRecord: true };
  }
  const folded = foldOmpTranscript(transcriptText);
  return {
    model: resolvedModel ?? folded.resolvedModelIdentity ?? folded.model,
    level: resolvedThinkingLevel ?? folded.thinking ?? "-",
    viaJobRecord: false,
  };
}

// The comparison itself, called only from evaluateMember below. The declared
// alias is a fleet tier name (ADR 0011/0014): `ok` requires the role it
// names to resolve to a model (`expected.model !== null`), that resolved
// model to match what the dispatched member actually ran under, and an
// exact level match — an unrecognised or unrouted declared model
// (`expected.model === null`) can never read `ok`, because `null === null`
// would let two different unrouted declarations pass as though they agreed
// on something.
function compare(member, declared, resolved, modelRoles) {
  const expected = expectedOmpModel(declared.model, modelRoles);
  const ok = expected.model !== null && modelsEqual(expected.model, resolved.model) && declared.level === resolved.level;
  return { member, ok, declared, resolved, expected };
}

// One member, declared vs a transcript/job-record resolution. `modelRoles`
// is required — the role target every declared alias is judged against.
export function evaluateMember(entry) {
  const declared = declaredPairFor(entry.frontmatter);
  const resolved = resolveActual(entry);
  return { ...compare(entry.member, declared, resolved, entry.modelRoles), viaJobRecord: resolved.viaJobRecord };
}

// The one-line failure shape the ticket's contract spells verbatim.
export function formatMismatch({ member, declared, resolved }) {
  return `${member}: declared ${declared.model}/${declared.level} resolved ${resolved.model}/${resolved.level}`;
}

// Follow-up line: which role the declared alias routed through and what
// that role currently targets — the context `formatMismatch`'s pair alone
// cannot carry, since a mismatch there could be a stale `modelRoles.<role>`
// just as easily as a wrong dispatch. stderr only, never appended to the
// ledger row (`appendedLedgerText`'s idempotency keys on `formatMismatch`'s
// exact line).
export function formatOmpExpectation(r) {
  const target = r.expected.role
    ? `@${r.expected.role} = ${r.expected.model ?? `(modelRoles.${r.expected.role} unset)`}`
    : "no role — model: is not a route (@slow|@task|@smol:<level>)";
  return `    ${r.member}: omp routes ${r.declared.model} through ${target}`;
}

// ledger.mjs has no per-member field — member-record.mjs's own header says so
// ("the ledger has no member concept and gains none here") — so the mismatch
// pair rides in the row's free text, APPENDED to whatever the row already
// held rather than replacing it, since `row` rewrites the whole line
// (ledger.mjs's `data.rows[i] = line`) and a bare mismatch note would drop
// `class=`, `KILLED` or `→ PR#` tokens a prior `row` call wrote for the same
// ticket. Idempotent on the identical note: the documented loop is check,
// fix, re-check (SKILL.md's "fix the definition or the dispatch and re-run
// the check before continuing"), and a member that still mismatches for the
// SAME reason on a later run must not grow the row a second time — a
// DIFFERENT note (a changed pair) still appends, since that is new
// information the row does not carry yet.
export function appendedLedgerText(existingText, mismatchNote) {
  const trimmed = String(existingText ?? "").trim();
  if (!trimmed) return mismatchNote;
  if (trimmed === mismatchNote || trimmed.endsWith(` · ${mismatchNote}`)) return trimmed;
  return `${trimmed} · ${mismatchNote}`;
}

// The agent-type half of an implementer's verdict: the definition the
// transcript's `session_init` says the member was DISPATCHED AS
// (`folded.agent` — the value member-record.mjs records as `subagent_type`)
// against the derived one. Judged apart from the model because a generic
// `task` dispatch can resolve to the role's target by coincidence and still
// not be the definition the run means to measure.
export function formatAgentMismatch({ member, agent, definition }) {
  return `${member}: dispatched ${agent ?? "(no agent on record)"}, expected ${definition}`;
}

// One implementer, both halves. `frontmatter` is null when `agents/` holds
// no file for the derived definition: nothing declares a tier to compare
// against, which can never read ok.
export function evaluateImplementer({ member, definition, frontmatter, transcriptText, resolvedModel, resolvedThinkingLevel, modelRoles }) {
  const agent = foldOmpTranscript(transcriptText).agent;
  const tier = frontmatter
    ? evaluateMember({ member, frontmatter, transcriptText, resolvedModel, resolvedThinkingLevel, modelRoles })
    : null;
  return { member, definition, agent, tier, ok: agent === definition && tier?.ok === true };
}

// Every reason an implementer failed, one line each, in the order printed.
export function implementerFailures(r) {
  const lines = [];
  if (r.agent !== r.definition) lines.push(formatAgentMismatch(r));
  if (r.tier === null) lines.push(`${r.member}: expected ${r.definition} has no agents/${r.definition}.agent.md to declare its tier`);
  else if (!r.tier.ok) lines.push(formatMismatch(r.tier));
  return lines;
}

// The verdict tokens fleet-tick.mjs reads. None parses as a member token
// (ledger-grammar.mjs's parseMember refuses a `tier-ok`/`tier-mismatch`
// name), so `ledger.mjs row` passes them as free text. `tier-mismatch=` is
// written only for a member already settled some other way — `settle`
// refuses to re-settle it, and the mismatch must still hold the next Pull.
export const tierOkToken = (member, definition) => `tier-ok=${member}:${definition}`;
export const tierMismatchToken = (member, definition) => `tier-mismatch=${member}:${definition}`;
// The third verdict: a SETTLED implementer whose `<session>/<member>.jsonl`
// does not exist under a session directory that does — a dispatch that
// failed before any transcript was written. It clears the tick's unchecked
// hold and is never read as `tier-ok=` (tier-outcomes.mjs falls through
// past it). The check exits UNVERIFIABLE_EXIT when it records one.
export const tierUnverifiableToken = (member) => `tier-unverifiable=${member}:no-transcript`;
export const UNVERIFIABLE_EXIT = 3;

// A single-token append, idempotent on the token's PRESENCE anywhere in the
// row — unlike appendedLedgerText's trailing-segment rule, which is for
// multi-word notes: a token is exact, and a later `row` or `settle` that
// wrote past it must not let a re-run add it a second time.
export function withToken(existingText, token) {
  const trimmed = String(existingText ?? "").trim();
  if (trimmed.split(/\s+/).includes(token)) return trimmed;
  return trimmed ? `${trimmed} · ${token}` : token;
}

// Where a member stands on the ledger, read the way `ledger.mjs settle`
// reads it — `## Dispatched` and every row, settled anywhere is settled:
// undefined when it is on the ledger nowhere, null while live, else its
// outcome.
export function memberOutcome(data, name) {
  const found = [...(data.dispatched ?? []).map(parseToken), ...(data.rows ?? []).flatMap(memberTokens)]
    .filter((t) => t?.name === name);
  if (found.length === 0) return undefined;
  return found.find((t) => t.outcome !== null)?.outcome ?? null;
}

// A ticket row's text past its `#<N>` key, "" when the ledger has no row.
export function rowText(data, ticket) {
  const key = `#${ticket}`;
  const row = (data.rows ?? []).find((r) => r.split(/\s/)[0] === key);
  return row ? row.slice(key.length).trim() : "";
}

// ---------------------------------------------------------------------------
// CLI — batch I/O, ledger append, exit code
// ---------------------------------------------------------------------------

const die = makeDie(NAME);
const { arg, sweep, stray } = defineFlags(die, {
  flags: { batch: "value", ledger: "value", repo: "value", "model-roles": "value" },
});

function resolvePath(repoRoot, p) {
  return isAbsolute(p) ? p : join(repoRoot, p);
}

// The `--session` lookup: a directly-dispatched member's transcript is a FLAT
// file named by its own AgentId (member-record.mjs's own `readOmpSession`
// comment), and the member's `name` in a batch entry IS that AgentId — so
// the path is exact, not searched. A member's own nested fan-out
// (`<parent-AgentId>/<stem>.jsonl`, one directory level down) is out of
// reach of this flat lookup — pass `--transcript` for a transcript this
// cannot find directly.
function resolveViaSession(repoRoot, sessionPath, member) {
  const root = resolvePath(repoRoot, sessionPath);
  const flat = join(root, `${member}.jsonl`);
  if (!existsSync(flat)) throw new Error(`no ${member}.jsonl found under --session ${sessionPath}`);
  return readFileSync(flat, "utf8");
}

// True only for a session path that IS a directory and holds no
// `<member>.jsonl`: the one shape that can mean a dispatch which never wrote
// a transcript. A path that does not exist, or is not a directory, is a
// caller's mistake and stays resolveViaSession's refusal.
function sessionLacksTranscript(repoRoot, sessionPath, member) {
  const root = resolvePath(repoRoot, sessionPath);
  return statSync(root, { throwIfNoEntry: false })?.isDirectory() === true && !existsSync(join(root, `${member}.jsonl`));
}

function runLedger(ledgerFile, args, what) {
  try {
    return execFileSync(process.execPath, [LEDGER_SCRIPT, ...(ledgerFile ? ["--file", ledgerFile] : []), ...args], { encoding: "utf8" });
  } catch (e) {
    die(`could not ${what}: ${e.stderr?.trim() || e.message}`);
  }
}

function readLedger(ledgerFile) {
  const raw = runLedger(ledgerFile, ["read"], "read the ledger");
  try {
    return JSON.parse(raw);
  } catch (e) {
    die(`could not read the ledger: ${e.message}`);
  }
}

function writeLedgerRow(ledgerFile, ticket, text) {
  runLedger(ledgerFile, ["row", String(ticket), text], `write ledger row #${ticket}`);
}

// An implementer's verdict, onto the ledger either way. Read fresh, not
// from the evaluation's copy: an earlier entry in this same batch may have
// written the row since. On a failure the reasons ride in the row's free
// text as ONE ` · `-joined note, so appendedLedgerText's trailing-segment
// idempotency covers a re-run of the whole verdict, and the member is
// settled `tier-mismatch` here rather than left to the controller — the
// hand step #1398 measured never taken.
function recordImplementer(ledgerFile, r) {
  const data = readLedger(ledgerFile);
  const existing = rowText(data, r.ticket);
  if (r.ok) {
    const token = tierOkToken(r.member, r.definition);
    const updated = withToken(existing, token);
    if (updated === existing) console.error(`    ${r.member}: row #${r.ticket} already carries ${token} — not written again`);
    else writeLedgerRow(ledgerFile, r.ticket, updated);
    return;
  }
  const lines = implementerFailures(r);
  for (const line of lines) console.error(line);
  if (r.tier && !r.tier.ok) console.error(formatOmpExpectation(r.tier));
  const outcome = memberOutcome(data, r.member);
  if (outcome === undefined) {
    die(`${r.member}: not on the ledger — \`ledger.mjs dispatch\` records a member before its tier can be settled`);
  }
  // A member already settled some other way (`bailed`, `killed`,
  // `released`, `PR#M`) cannot be re-settled — `settle` refuses — so the
  // mismatch rides as a row token instead, ahead of the note so the note
  // stays the row's trailing segment.
  let updated = outcome === null || outcome === "tier-mismatch"
    ? existing
    : withToken(existing, tierMismatchToken(r.member, r.definition));
  updated = appendedLedgerText(updated, lines.join(" · "));
  if (updated === existing) console.error(`    ${r.member}: row #${r.ticket} already carries this exact verdict — not appended again`);
  else writeLedgerRow(ledgerFile, r.ticket, updated);
  if (outcome === null) runLedger(ledgerFile, ["settle", r.member, "tier-mismatch"], `settle ${r.member} tier-mismatch`);
}

// A settled implementer whose transcript does not exist can never be judged,
// and holding the tick on it forever is the deadlock this verdict ends: the
// token clears `HOLD (tier unchecked …)` without claiming the tier was right,
// which is why it is neither `tier-ok=` nor `tier-mismatch=`. Appended once,
// on the ticket's row, under the same presence rule as the other two.
function recordUnverifiable(ledgerFile, r) {
  const token = tierUnverifiableToken(r.member);
  console.error(`${r.member}: settled ${r.outcome} with no ${r.member}.jsonl under --session ${r.session} — nothing to check; recorded ${token}`);
  const existing = rowText(readLedger(ledgerFile), r.ticket);
  const updated = withToken(existing, token);
  if (updated === existing) console.error(`    ${r.member}: row #${r.ticket} already carries ${token} — not written again`);
  else writeLedgerRow(ledgerFile, r.ticket, updated);
}

function main() {
  const batchPath = arg("batch");
  if (!batchPath) die("usage: tier-check.mjs --batch <path-to-json> [--ledger <path>] [--repo <path>] [--model-roles <path>]");
  const ledgerFile = arg("ledger");
  const repoRoot = arg("repo") ?? join(SCRIPT_DIR, "..");

  // #1669: this file bound only makeDie/makeArg, so a stray or misspelled
  // flag (`--ledgerr`) was silently ignored and the run computed a real
  // verdict against the DEFAULT ledger — the fail-open harm arg.mjs exists
  // to prevent. Below the arg() reads and the --batch usage guard above,
  // per arg.mjs's sweep() ordering contract, so a roster flag given with
  // no value (or --batch omitted entirely) still answers its own
  // needs-a-value/usage message rather than a generic stray complaint.
  // Above the batch file's own JSON/array checks below, so a stray riding
  // along with a well-formed --batch is refused by name instead of being
  // silently absorbed into a batch-content error.
  sweep();
  // #463: sweep() only refuses a `--`-prefixed token; a bare or single-dash
  // one (`-ledger`, the single-dash cousin of the ticket's own `--ledgerr`)
  // rode along in silence the same way. This file takes no positional, so
  // any leftover token is a stray.
  stray();

  let entries;
  try {
    entries = JSON.parse(readFileSync(batchPath, "utf8"));
  } catch (e) {
    die(`could not read --batch ${batchPath}: ${e.message}`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    die(`--batch ${batchPath} must be a JSON array of at least one member entry`);
  }

  // Read once per invocation, before the map: every entry in the batch is
  // judged against the SAME operator config, never a per-entry re-read.
  const modelRolesPath = arg("model-roles");
  let modelRoles;
  try {
    modelRoles = modelRolesPath ? JSON.parse(readFileSync(modelRolesPath, "utf8")) : readOmpConfigValue("modelRoles");
  } catch (e) {
    die(e.message);
  }
  if (typeof modelRoles !== "object" || modelRoles === null || Array.isArray(modelRoles)) {
    die(`${modelRolesPath ? `--model-roles ${modelRolesPath}` : "omp config get modelRoles --json"} must be a JSON object`);
  }

  // The ledger is read at most once for evaluation: every implementer's
  // expected definition comes off its row, and nothing this loop does
  // writes a `tier=` token.
  let ledgerData = null;
  const results = entries.map((raw) => {
    const parsed = parseMember(String(raw.member ?? ""));
    const impl = parsed?.family === "impl";
    if (!raw.member || (!impl && !raw.agentFile)) {
      die(`batch entry missing member/agentFile: ${JSON.stringify(raw)}`);
    }
    if (impl && raw.agentFile) {
      die(`${raw.member}: an impl- entry carries no agentFile — its definition is derived from the ledger row's tier= token`);
    }
    const hasJobRecord = raw.resolvedModel && raw.resolvedThinkingLevel;
    let frontmatter = null, transcriptText = null, ticket = null, definition = null;
    try {
      if (impl) {
        ticket = parsed.number;
        ledgerData ??= readLedger(ledgerFile);
        definition = expectedDefinition(rowText(ledgerData, ticket));
        const definitionFile = join(repoRoot, "agents", `${definition}.agent.md`);
        if (existsSync(definitionFile)) frontmatter = parseFrontmatter(readFileSync(definitionFile, "utf8"));
      } else {
        frontmatter = parseFrontmatter(readFileSync(resolvePath(repoRoot, raw.agentFile), "utf8"));
      }
      // An implementer's transcript is read even beside a full job record:
      // the agent type it was dispatched as lives only there.
      if (impl || !hasJobRecord) {
        if (raw.session) {
          // A settled implementer with no transcript under a session
          // directory that does exist: its dispatch failed before one was
          // written, so there is nothing to judge. Recorded, not refused —
          // see recordUnverifiable. A live member, one on the ledger nowhere,
          // or a session path that is not a directory still refuses below.
          if (impl && sessionLacksTranscript(repoRoot, raw.session, raw.member)) {
            const outcome = memberOutcome(ledgerData, raw.member);
            if (outcome) return { impl: true, unverifiable: true, member: raw.member, ticket, outcome, session: raw.session };
          }
          transcriptText = resolveViaSession(repoRoot, raw.session, raw.member);
        } else if (raw.transcript) {
          transcriptText = readFileSync(resolvePath(repoRoot, raw.transcript), "utf8");
        } else if (impl) {
          throw new Error("an impl- entry needs session or transcript — the agent type it was dispatched as is read off its own transcript, which no job record carries");
        } else {
          // Reached by BOTH a fully absent job record and a PARTIAL one
          // (only `resolvedModel` or only `resolvedThinkingLevel`) — a
          // partial record still needs a transcript for its missing half,
          // never a silent "-" default (finding #2).
          throw new Error("no --transcript or --session given, and no full omp job record (both resolvedModel and resolvedThinkingLevel) supplied");
        }
      }
    } catch (e) {
      die(`${raw.member}: ${e.message}`);
    }

    const entry = {
      member: raw.member, frontmatter, transcriptText,
      resolvedModel: raw.resolvedModel, resolvedThinkingLevel: raw.resolvedThinkingLevel,
      modelRoles,
    };
    return impl
      ? { impl: true, ticket, ...evaluateImplementer({ ...entry, definition }) }
      : { impl: false, ...evaluateMember(entry) };
  });

  for (const r of results) {
    if (r.unverifiable) {
      recordUnverifiable(ledgerFile, r);
      continue;
    }
    if (r.impl) {
      recordImplementer(ledgerFile, r);
      continue;
    }
    if (r.ok) continue;
    const line = formatMismatch(r);
    console.error(line);
    if (r.expected) console.error(formatOmpExpectation(r));
    const { ticket } = parseMemberName(r.member);
    if (!ticket) {
      console.error(`    ${r.member}: no ticket derivable from the member name — tier-mismatch pair not written to the ledger`);
      continue;
    }
    const existing = rowText(readLedger(ledgerFile), ticket);
    const updated = appendedLedgerText(existing, line);
    if (updated === existing) {
      console.error(`    ${r.member}: ledger row for #${ticket} already carries this exact pair — not appended again`);
      continue;
    }
    writeLedgerRow(ledgerFile, ticket, updated);
  }

  // A mismatch outranks an unverifiable member in a mixed batch: it is the
  // one the controller must act on.
  const failed = results.some((r) => !r.unverifiable && !r.ok);
  process.exit(failed ? 1 : results.some((r) => r.unverifiable) ? UNVERIFIABLE_EXIT : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
