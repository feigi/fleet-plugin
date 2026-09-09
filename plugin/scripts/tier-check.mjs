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
// record via member-record.mjs's fold functions (#1342): Claude's `d.effort`
// off the member's own subagent transcript, omp's `thinking_level_change` off
// its own. omp additionally has a shortcut #1302 measured on real job
// records: the controller's own task job carries `resolvedModel`/
// `resolvedThinkingLevel` already, so a caller that already holds those two
// fields never has to open the child's session file at all — a batch entry
// giving either one skips `transcript` entirely (this ticket's 4th fixture).
//
// Compare is by FAMILY on the model (`opus` <-> `claude-opus-5`, `sonnet` <->
// `claude-sonnet-5`, `haiku` <-> `claude-haiku-4-5` — an alias and the
// versioned id it resolves to are not a mismatch, per #1298's premise
// correction: aliases DO resolve on both harnesses) and EXACT on the level
// (`effort`/`thinking-level` verbatim — #1343 is what makes omp's side of
// that meaningful; before it every member ran omp's default thinking level
// regardless of what the frontmatter declared).
//
// A batch, not one member: run-team's phase 2 dispatches several members per
// wave and calls this ONCE after the batch, so `--batch` takes a JSON array
// and the failure line — `member: declared <m>/<l> resolved <m>/<l>` — is
// printed once per member that mismatched, not once per invocation.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeDie, makeArg } from "./arg.mjs";
import { foldClaudeTranscript, foldOmpTranscript, parseMemberName } from "./member-record.mjs";

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

// Family only, never the generation. A bare alias and the versioned id it
// resolves to on either harness name the SAME dispatched model — #1298's
// premise correction is exactly this: `model: opus` resolving to
// `anthropic/claude-opus-5` is success, not a hole to widen. An unrecognised
// spelling returns null, which the caller below never treats as matching
// another null — an unknown model refuses loudly rather than comparing equal
// to another unknown one by accident.
export function familyOf(model) {
  const m = String(model ?? "").trim();
  if (!m) return null;
  if (m === "opus" || m.startsWith("claude-opus-")) return "opus";
  if (m === "sonnet" || m.startsWith("claude-sonnet-")) return "sonnet";
  if (m === "haiku" || m.startsWith("claude-haiku-")) return "haiku";
  return null;
}

// The resolved pair. `resolvedModel`/`resolvedThinkingLevel` are the omp job
// record's own fields (#1302) — when either is given, `transcriptText` is
// never read at all, which is this ticket's 4th fixture. Otherwise the
// harness picks which fold function reads it: Claude's `d.effort` is
// per-line and already last-wins inside foldClaudeTranscript, so
// `effort || "-"` mirrors readClaudeMember's own hole-visible spelling
// rather than reading a lost effort control (haiku has none) as a mismatch.
export function resolveActual({ harness, transcriptText, resolvedModel, resolvedThinkingLevel }) {
  if (harness === "omp" && (resolvedModel || resolvedThinkingLevel)) {
    return { model: resolvedModel ?? null, level: resolvedThinkingLevel ?? null, viaJobRecord: true };
  }
  if (harness === "claude") {
    const folded = foldClaudeTranscript(transcriptText);
    return { model: folded.model, level: folded.effort || "-", viaJobRecord: false };
  }
  const folded = foldOmpTranscript(transcriptText);
  return { model: folded.model, level: folded.thinking ?? "-", viaJobRecord: false };
}

// One member, declared vs resolved. `ok` requires BOTH a recognised, matching
// family AND an exact level match — an unrecognised declared model
// (familyOf → null) can never read `ok`, because `null === null` would let
// two different unrecognised spellings pass as though they agreed on
// something.
export function evaluateMember(entry) {
  const declared = declaredPairFor(entry.frontmatter, entry.harness);
  const resolved = resolveActual(entry);
  const declaredFamily = familyOf(declared.model);
  const ok = declaredFamily !== null && declaredFamily === familyOf(resolved.model) && declared.level === resolved.level;
  return { member: entry.member, ok, declared, resolved, viaJobRecord: resolved.viaJobRecord };
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
// ticket.
export function appendedLedgerText(existingText, mismatchNote) {
  const trimmed = String(existingText ?? "").trim();
  return trimmed ? `${trimmed} · ${mismatchNote}` : mismatchNote;
}

// ---------------------------------------------------------------------------
// CLI — batch I/O, ledger append, exit code
// ---------------------------------------------------------------------------

const die = makeDie(NAME);
const arg = makeArg(die);

function resolvePath(repoRoot, p) {
  return isAbsolute(p) ? p : join(repoRoot, p);
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
    const hasJobRecord = raw.harness === "omp" && (raw.resolvedModel || raw.resolvedThinkingLevel);
    let frontmatter, transcriptText = null;
    try {
      frontmatter = parseFrontmatter(readFileSync(resolvePath(repoRoot, raw.agentFile), "utf8"));
      if (!hasJobRecord) {
        if (!raw.transcript) throw new Error("no --transcript given and no omp job record supplied");
        transcriptText = readFileSync(resolvePath(repoRoot, raw.transcript), "utf8");
      }
    } catch (e) {
      die(`${raw.member}: ${e.message}`);
    }
    return evaluateMember({
      member: raw.member, harness: raw.harness, frontmatter, transcriptText,
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
    writeLedgerRow(ledgerFile, ticket, appendedLedgerText(existing, line));
  }

  process.exit(mismatches.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
