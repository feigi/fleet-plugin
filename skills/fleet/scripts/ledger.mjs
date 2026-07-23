#!/usr/bin/env node
// The run ledger. A controller's context is the least durable thing in a fleet
// run: it compacts, and a controller that has lost the pool or the dispatch map
// redoes finished work. Two duplicate tickets shipped in one run from exactly
// that.
//
// Rows are rewritten in place, one per ticket. `filed` and `ruled` are
// append-only, because their whole purpose is to outlive the reasoning that
// produced them.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname } from "node:path";

const NAME = "ledger";

function die(msg) {
  console.error(`${NAME}: ${msg}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const fileIdx = argv.indexOf("--file");
const file = fileIdx === -1 ? ".fleet/ledger.md" : argv[fileIdx + 1];
if (fileIdx !== -1) argv.splice(fileIdx, 2);
if (!file) die("--file given with no path");
const requireFileIdx = argv.indexOf("--require-file");
const requireFile = requireFileIdx !== -1;
if (requireFileIdx !== -1) argv.splice(requireFileIdx, 1);

const [cmd, ...rest] = argv;
if (!cmd) die("usage: ledger.mjs [--file <path>] [--require-file] row|filed|ruled|check|read [args]");

const ROWS = "## Rows";
const FILED = "## Filed";
const RULED = "## Ruled";

// One entry is always exactly one physical line on disk. Escape backslash
// first, then newline, so a `\` in entry text can never be mistaken for the
// start of an escape sequence introduced by this encoding. Without this, an
// entry containing a real newline — or a line that happens to look like
// `## Filed` or `- #999 ...` — gets misparsed on reload: real records
// silently drop, or phantom ones get injected.
function escapeText(s) {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
function unescapeText(s) {
  return s.replace(/\\(\\|n)/g, (_, c) => (c === "n" ? "\n" : "\\"));
}

function load() {
  if (!existsSync(file)) return { rows: [], filed: [], ruled: [] };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    die(`cannot read ${file}: ${e.message}`);
  }
  const section = (name) => {
    // Anchored to a real line start (or string start), not a bare substring
    // search — otherwise an escaped entry that merely CONTAINS the text
    // "## Filed" (never a physical line, just a run of characters inside a
    // one-line entry) is found by indexOf() before the genuine header and
    // the whole section is sliced from the wrong offset.
    const headerRe = new RegExp(`(^|\\n)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n|$)`);
    const m = headerRe.exec(text);
    if (!m) return [];
    const start = m.index + m[1].length + name.length;
    const after = text.slice(start);
    const end = after.search(/\n## /);
    return (end === -1 ? after : after.slice(0, end))
      .split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "))
      .map((l) => unescapeText(l.slice(2)));
  };
  return { rows: section(ROWS), filed: section(FILED), ruled: section(RULED) };
}

function save(d) {
  const out =
    `# Fleet run ledger\n\n${ROWS}\n\n` + d.rows.map((r) => `- ${escapeText(r)}`).join("\n") +
    `\n\n${FILED}\n\n` + d.filed.map((r) => `- ${escapeText(r)}`).join("\n") +
    `\n\n${RULED}\n\n` + d.ruled.map((r) => `- ${escapeText(r)}`).join("\n") + "\n";
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write to a sibling temp file and rename over the target. rename is
    // atomic on a POSIX filesystem — a crash mid-write leaves the temp file
    // corrupt but never truncates the durability file itself.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, out);
    renameSync(tmp, file);
  } catch (e) {
    die(`cannot write ${file}: ${e.message}`);
  }
  console.error(`    wrote ${file}`);
}

const data = load();

if (cmd === "read") {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

if (cmd === "row") {
  const [ticket, ...textParts] = rest;
  if (!ticket || textParts.length === 0) die("usage: ledger.mjs row <ticket> <text>");
  const key = ticket.startsWith("#") ? ticket : `#${ticket}`;
  const line = `${key} ${textParts.join(" ")}`;
  const i = data.rows.findIndex((r) => r.split(/\s/)[0] === key);
  const created = i === -1;
  if (created) {
    data.rows.push(line);
  } else {
    data.rows[i] = line;
  }
  // Logged only after save() returns — a failed write must not claim a row
  // was recorded when it never made it to disk.
  save(data);
  console.error(created ? `    new row ${key}` : `    rewrote row ${key}`);
  console.log(JSON.stringify({ ticket: key, line, created }, null, 2));
  process.exit(0);
}

if (cmd === "filed") {
  const [issue, ...subjectParts] = rest;
  if (!issue || subjectParts.length === 0) die("usage: ledger.mjs filed <issue> <subject>");
  const subject = subjectParts.join(" ");
  data.filed.push(`#${issue.replace(/^#/, "")} ${subject}`);
  save(data);
  console.log(JSON.stringify({ issue, subject, total: data.filed.length }, null, 2));
  process.exit(0);
}

if (cmd === "ruled") {
  const [pr, ...decisionParts] = rest;
  if (!pr || decisionParts.length === 0) die("usage: ledger.mjs ruled <pr> <decision>");
  const decision = decisionParts.join(" ");
  data.ruled.push(`#${pr.replace(/^#/, "")} ${decision}`);
  save(data);
  console.log(JSON.stringify({ pr, decision, total: data.ruled.length }, null, 2));
  process.exit(0);
}

if (cmd === "check") {
  // The first check of a run legitimately has no file yet, so absence alone
  // cannot be an error — but a silent "safe to file" for every check when
  // the path is simply wrong (typo'd --file) is a fail-open that no caller
  // would notice. Warn loudly by default; --require-file makes absence a
  // hard failure for callers that know the file must already exist.
  if (!existsSync(file)) {
    if (requireFile) die(`--require-file given but ledger file does not exist: ${file}`);
    console.error(
      `${NAME}: WARNING — ledger file not found: ${file}. Every check will read "safe to file" until it exists.`,
    );
  }
  const subject = rest.join(" ");
  if (!subject) die("usage: ledger.mjs check <subject>");
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokenSet = (s) => new Set(norm(s).split(/\s+/).filter(Boolean));
  const target = tokenSet(subject);
  if (target.size === 0) die(`normalised subject is empty — '${subject}' has no alphanumeric tokens to check`);
  // Substring matching collides both ways: a short generic subject ("line")
  // matches everything (false "already filed" silently loses a finding),
  // while an all-punctuation subject normalises to "" and matches anything
  // too. Token-set matching fixes both, with a deliberate asymmetric bias —
  // a false "already filed" is invisible and bad, a false "not filed" just
  // creates a duplicate someone closes — so equal sets OR a >=4-token subset
  // both count as a match, catching real near-duplicate rewordings without
  // matching short generic overlaps.
  const isMatch = (filedTokens) => {
    if (filedTokens.size === target.size && [...filedTokens].every((t) => target.has(t))) return true;
    const [small, big] = filedTokens.size <= target.size ? [filedTokens, target] : [target, filedTokens];
    return small.size >= 4 && [...small].every((t) => big.has(t));
  };
  const match = data.filed.find((f) => isMatch(tokenSet(f)));
  if (match) {
    console.error(`${NAME}: ALREADY FILED — ${match}`);
    console.log(JSON.stringify({ subject, found: true, match }, null, 2));
    // Exit 1 means "do not file this again". Non-zero is the stop signal, so a
    // caller that checks only the exit status still cannot duplicate.
    process.exit(1);
  }
  console.error(`${NAME}: not previously filed`);
  console.log(JSON.stringify({ subject, found: false, match: null }, null, 2));
  process.exit(0);
}

die(`unknown subcommand '${cmd}' — expected row, filed, ruled, check or read`);
