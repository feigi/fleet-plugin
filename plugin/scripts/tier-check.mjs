#!/usr/bin/env node
// The dispatch-time tier check (#1345, ruled on #1298). Layer 2 of two: layer
// 1 (#1314) is a static audit of the agent files' SHAPE, before any run
// exists; this layer compares what a run actually DISPATCHED against what
// the harness's own record says it RESOLVED, for every member dispatched by
// named definition, on both harnesses. Not a lint — a refusal, run once per
// dispatch batch and named to stop the wave (run-team/SKILL.md's phase 2).
//
// Declared is the definition's own frontmatter — `model` (bare alias, both
// harnesses), `effort` (Claude), `thinking-level` (omp) — the one tree #1297
// ruled, no per-harness shells. Resolved is read back from the harness's own
// record, three ways, in preference order:
//   1. the omp job record's OWN `resolvedModel`/`resolvedThinkingLevel`
//      (#1302) — a controller that already holds BOTH never opens the
//      child's file at all (this ticket's 4th fixture). Holding only one is
//      the ordinary case, not a corner (the two live on different omp
//      records), so the missing half is read off the transcript instead of
//      reported as a lie.
//   2. `--session <dir>` — the controller's own session/subagents root, when
//      it has no job record (or only half of one) but knows where its
//      dispatched members' own transcripts live. Resolved via
//      member-record.mjs's readers, never reimplemented here (#1342).
//   3. `--transcript <file>` — the member's own transcript, when the caller
//      already holds the exact path (tests, or a caller with no session
//      root handy).
//
// Compare is by FAMILY on the model (`opus` <-> `claude-opus-5`, `sonnet` <->
// `claude-sonnet-5`, `haiku` <-> `claude-haiku-4-5`) and EXACT on the level
// (`effort`/`thinking-level` verbatim). Real spellings on both harnesses
// carry more than the bare family name — omp's `resolvedModel`/
// `resolvedModelIdentity` are ALWAYS provider-prefixed
// (`anthropic/claude-opus-5`, `anthropic/claude-opus-5:high` — 906/906
// measured, zero bare) and Claude's own transcript spells a context-window
// variant (`claude-opus-5[1m]`) or a dated generation
// (`claude-haiku-4-5-20251001`) — so `familyOf` strips the provider prefix
// and any `:suffix`/`[bracket]` tail before matching, the same normalisation
// member-record.mjs's own `normalizeModel` applies for the bracket case.
//
// A batch, not one member: run-team's phase 2 dispatches several members per
// wave and calls this ONCE after the batch, so `--batch` takes a JSON array
// and the failure line — `member: declared <m>/<l> resolved <m>/<l>` — is
// printed once per member that mismatched, not once per invocation. See
// run-team/SKILL.md's phase-2 dispatch paragraph for the batch file's exact
// entry shape and how the controller obtains each field.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeDie, makeArg } from "./arg.mjs";
import { foldClaudeTranscript, foldOmpTranscript, parseMemberName, readMembers } from "./member-record.mjs";

const NAME = "tier-check";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const LEDGER_SCRIPT = join(SCRIPT_DIR, "ledger.mjs");

// ---------------------------------------------------------------------------
// pure core — unit-tested directly (tier-check.test.mjs), no filesystem or
// process access below this line until main()
// ---------------------------------------------------------------------------

// Frontmatter reader duplicated in SHAPE from implementer-model-tier.test.mjs's
// `frontmatterOf`/`field`, not shared: that file pins the declaration's own
// prose-adjacent contract (no `tools:`, bare alias) off test-local anchors;
// this reads the same five keys for a runtime comparison, a different
// consumer with a different failure mode (exit 1, not a red test). Two
// two-line regexes are not worth a third module importing from a test file.
export function parseFrontmatter(agentFileText) {
  const fm = String(agentFileText ?? "").split("---")[1] ?? "";
  const field = (key) => new RegExp(`^${key}:\\s*(\\S+)$`, "m").exec(fm)?.[1] ?? null;
  return { model: field("model"), effort: field("effort"), thinkingLevel: field("thinking-level") };
}

// The declared PAIR a given harness's dispatch is judged against — `effort`
// on Claude, `thinking-level` on omp, never both at once: a member dispatched
// on one harness never carries the other harness's level, and comparing
// against it would refuse a mismatch that was never dispatched.
export function declaredPairFor(frontmatter, harness) {
  const level = harness === "claude" ? frontmatter.effort : frontmatter.thinkingLevel;
  return { model: frontmatter.model, level };
}

// Family only, never the generation, the provider, or the trailing level tag.
// A bare alias and the versioned id it resolves to on either harness name the
// SAME dispatched model — #1298's premise correction is exactly this:
// `model: opus` resolving to `anthropic/claude-opus-5` is success, not a hole
// to widen. Measured real spellings this strips before matching:
//   - omp's own `resolvedModel`/`resolvedModelIdentity`/transcript `model`
//     are ALWAYS provider-prefixed (`anthropic/claude-opus-5`) and sometimes
//     carry a trailing `:level` (`anthropic/claude-opus-5:high`) — 906/906
//     and 0/906 bare, measured across real `~/.omp/agent/sessions/**`.
//   - Claude's transcript spells a context-window variant
//     (`claude-opus-5[1m]`) or a dated generation
//     (`claude-haiku-4-5-20251001`).
// An unrecognised spelling returns null, which the caller below never treats
// as matching another null — an unknown model refuses loudly rather than
// comparing equal to another unknown one by accident.
export function familyOf(model) {
  const m = String(model ?? "").trim()
    .replace(/^[^/]+\//, "") // provider prefix: anthropic/claude-opus-5 -> claude-opus-5
    .replace(/\[[^\]]*\]$/, "") // context-window variant: claude-opus-5[1m] -> claude-opus-5
    .replace(/:[^:]*$/, ""); // trailing level tag: claude-opus-5:high -> claude-opus-5
  if (!m) return null;
  if (m === "opus" || m.startsWith("claude-opus-")) return "opus";
  if (m === "sonnet" || m.startsWith("claude-sonnet-")) return "sonnet";
  if (m === "haiku" || m.startsWith("claude-haiku-")) return "haiku";
  return null;
}

// The resolved pair off a transcript (or the omp job record). The omp
// short-circuit requires BOTH `resolvedModel` AND `resolvedThinkingLevel` —
// they live on different omp records (`session_init` carries
// `resolvedModel`/`resolvedModelIdentity`, `thinking_level_change` carries
// `thinkingLevel`; no single line carries both, measured 906 of the former
// against 232 of the latter), so holding only one is the ORDINARY case, not
// a corner, and the missing half is read off the transcript rather than
// reported as `null` (a `null` reaching `formatMismatch` would print
// `resolved .../null`, a lie about a harness field nobody asked was absent).
//
// omp's transcript-derived model prefers `resolvedModelIdentity`
// (`session_init`, written at DISPATCH) over the assistant turn's own
// `model`: the identity exists before the member's first turn, where the
// per-turn model does not, so preferring it is what makes this check usable
// immediately after a background dispatch rather than only once a member has
// already produced output.
export function resolveActual({ harness, transcriptText, resolvedModel, resolvedThinkingLevel }) {
  if (harness === "claude") {
    const folded = foldClaudeTranscript(transcriptText);
    return { model: folded.model, level: folded.effort || "-", viaJobRecord: false };
  }
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

// The resolved pair off an already-computed member-record.mjs RECORD
// (readClaudeSession/readOmpSession's own row shape), for the `--session`
// lookup path. omp's row carries `resolvedModelIdentity` as an additive
// field (#1345's extension to readOmpMember) alongside the historical
// per-turn `model` — prefer it for the same reason resolveActual does.
export function resolvedPairFromRecord(record, harness) {
  if (harness === "omp") {
    return { model: record.resolvedModelIdentity ?? record.model, level: record.thinking ?? "-" };
  }
  return { model: record.model, level: record.thinking ?? "-" };
}

// The comparison itself, shared by both resolution paths below. `ok`
// requires BOTH a recognised, matching family AND an exact level match — an
// unrecognised declared model (familyOf -> null) can never read `ok`,
// because `null === null` would let two different unrecognised spellings
// pass as though they agreed on something.
function compare(member, declared, resolved) {
  const declaredFamily = familyOf(declared.model);
  const ok = declaredFamily !== null && declaredFamily === familyOf(resolved.model) && declared.level === resolved.level;
  return { member, ok, declared, resolved };
}

// One member, declared vs a transcript/job-record resolution.
export function evaluateMember(entry) {
  const declared = declaredPairFor(entry.frontmatter, entry.harness);
  const resolved = resolveActual(entry);
  return { ...compare(entry.member, declared, resolved), viaJobRecord: resolved.viaJobRecord };
}

// One member, declared vs a member-record.mjs record already resolved via
// `--session`. `viaJobRecord` is always false here — reaching a record at
// all means a transcript was read to build it.
export function evaluateMemberFromRecord({ member, harness, frontmatter, record }) {
  const declared = declaredPairFor(frontmatter, harness);
  const resolved = resolvedPairFromRecord(record, harness);
  return { ...compare(member, declared, resolved), viaJobRecord: false };
}

// The one-line failure shape the ticket's contract spells verbatim.
export function formatMismatch({ member, declared, resolved }) {
  return `${member}: declared ${declared.model}/${declared.level} resolved ${resolved.model}/${resolved.level}`;
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

// ---------------------------------------------------------------------------
// CLI — batch I/O, ledger append, exit code
// ---------------------------------------------------------------------------

const die = makeDie(NAME);
const arg = makeArg(die);

function resolvePath(repoRoot, p) {
  return isAbsolute(p) ? p : join(repoRoot, p);
}

// The `--session` lookup. Claude and omp are NOT symmetric here, and the
// asymmetry is deliberate rather than an oversight:
//
// - Claude: `readMembers([session])` (#1342) walks `session` for a
//   `subagents/` directory at any depth and folds every member it finds,
//   keyed on `meta.name` — exactly member-outcomes.mjs's own CLI usage
//   ("handed a session dir directly"), reused rather than reimplemented.
//   A member with no assistant turn yet reads as ABSENT (readClaudeMember's
//   own `if (!folded.model) return null`) — accepted here, because Claude
//   has no earlier per-dispatch signal at all (unlike omp's
//   `resolvedModelIdentity`); tier-checking a still-running Claude member
//   needs no fix in THIS file, since the harness itself gives nothing yet.
// - omp: bypasses `readMembers`/`readOmpMember` entirely and reads
//   `<session>/<member>.jsonl` directly through `foldOmpTranscript`. omp
//   session directories hold each member's transcript as a FLAT file named
//   by its own AgentId (member-record.mjs's own `readOmpSession` comment),
//   and the member's `name` in a batch entry IS that AgentId — so the path
//   is exact, not searched. Going through `readOmpMember` instead would
//   inherit its `if (!folded.model) return null` gate, which is right for
//   member-outcomes.mjs's historical scrape but wrong here: it would hide a
//   still-running member's `resolvedModelIdentity` (written at dispatch,
//   before any turn) behind the very early-detection this ticket exists to
//   use. Nested workflow fan-out (`workflows/wf_<id>/<stem>.jsonl`) is out
//   of reach of this flat lookup — pass `--transcript` for those.
function resolveViaSession(repoRoot, sessionPath, member, harness) {
  const root = resolvePath(repoRoot, sessionPath);
  if (harness === "omp") {
    const flat = join(root, `${member}.jsonl`);
    if (!existsSync(flat)) throw new Error(`no ${member}.jsonl found under --session ${sessionPath}`);
    return { transcriptText: readFileSync(flat, "utf8") };
  }
  const rows = readMembers([root]).filter((r) => r.member === member);
  if (rows.length === 0) throw new Error(`no member named ${member} found under --session ${sessionPath}`);
  // Last-wins on more than one match (a re-dispatched member), mirroring the
  // fold functions' own "the later one is the tier the output reflects" rule.
  return { record: rows[rows.length - 1] };
}

function readLedgerRow(ledgerFile, ticket) {
  const args = [LEDGER_SCRIPT, ...(ledgerFile ? ["--file", ledgerFile] : []), "read"];
  let data;
  try {
    data = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8" }));
  } catch (e) {
    die(`could not read the ledger to append the tier-mismatch pair: ${e.message}`);
  }
  const row = (data.rows ?? []).find((r) => r.split(/\s/)[0] === `#${ticket}`);
  return row ? row.slice(row.indexOf(" ") + 1) : "";
}

function writeLedgerRow(ledgerFile, ticket, text) {
  const args = [LEDGER_SCRIPT, ...(ledgerFile ? ["--file", ledgerFile] : []), "row", ticket, text];
  try {
    execFileSync(process.execPath, args, { encoding: "utf8" });
  } catch (e) {
    die(`could not write the tier-mismatch pair to the ledger: ${e.message}`);
  }
}

function main() {
  const batchPath = arg("batch");
  if (!batchPath) die("usage: tier-check.mjs --batch <path-to-json> [--ledger <path>] [--repo <path>]");
  const ledgerFile = arg("ledger");
  const repoArg = arg("repo");
  const repoRoot = repoArg ?? join(SCRIPT_DIR, "..");

  let entries;
  try {
    entries = JSON.parse(readFileSync(batchPath, "utf8"));
  } catch (e) {
    die(`could not read --batch ${batchPath}: ${e.message}`);
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    die(`--batch ${batchPath} must be a JSON array of at least one member entry`);
  }

  const results = entries.map((raw) => {
    if (!raw.member || !raw.agentFile || !raw.harness) {
      die(`batch entry missing member/agentFile/harness: ${JSON.stringify(raw)}`);
    }
    const hasJobRecord = raw.harness === "omp" && raw.resolvedModel && raw.resolvedThinkingLevel;
    let frontmatter, viaSession = null, transcriptText = null;
    try {
      frontmatter = parseFrontmatter(readFileSync(resolvePath(repoRoot, raw.agentFile), "utf8"));
      if (!hasJobRecord) {
        if (raw.session) {
          viaSession = resolveViaSession(repoRoot, raw.session, raw.member, raw.harness);
        } else if (raw.transcript) {
          transcriptText = readFileSync(resolvePath(repoRoot, raw.transcript), "utf8");
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

    if (viaSession?.record) {
      return evaluateMemberFromRecord({ member: raw.member, harness: raw.harness, frontmatter, record: viaSession.record });
    }
    return evaluateMember({
      member: raw.member, harness: raw.harness, frontmatter,
      transcriptText: viaSession?.transcriptText ?? transcriptText,
      resolvedModel: raw.resolvedModel, resolvedThinkingLevel: raw.resolvedThinkingLevel,
    });
  });

  const mismatches = results.filter((r) => !r.ok);
  for (const r of mismatches) {
    const line = formatMismatch(r);
    console.error(line);
    const { ticket } = parseMemberName(r.member);
    if (!ticket) {
      console.error(`    ${r.member}: no ticket derivable from the member name — tier-mismatch pair not written to the ledger`);
      continue;
    }
    const existing = readLedgerRow(ledgerFile, ticket);
    const updated = appendedLedgerText(existing, line);
    if (updated === existing) {
      console.error(`    ${r.member}: ledger row for #${ticket} already carries this exact pair — not appended again`);
      continue;
    }
    writeLedgerRow(ledgerFile, ticket, updated);
  }

  process.exit(mismatches.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
