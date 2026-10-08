// #2243, the gate ADR 0019 orders last (#2230). Everything under `plugin/`
// ships to consumers, so it names nothing that does not ship: no issue or PR
// number of this repo in any form, no foreign tracker number, no ADR number,
// no repo-internal `docs/` record path, no test-file name. The ten sweep
// slices (#2233-#2242) and this ticket emptied the scan; this file keeps it
// empty.
//
// WHOLE FILE, every tracked file under `plugin/`, every type. Not a comment
// scan: ADR 0019 puts runtime strings in scope beside prose and comments, and
// a citation inside a `die` string or a prompt literal reaches a consumer's
// agent exactly as one in a comment does (PR #2508's review, ticket #2238:
// ` — ADR 0015` restored inside claim-ticket.sh's `rederive` string left every
// test green).
//
// STITCHING, the lesson line-distance-prose.test.mjs records: a phrase that
// straddles a wrap escapes a per-line grep. Whole-file matching gets the
// markdown wrap for free; GAP below also lets `PR` / `ADR` and their number
// sit either side of a comment wrap, across the `//`, `#`, `*` or `>` gutter.
// Measured before landing: it found one citation ADR 0019's line-wise scan
// could not, tier-roles.mjs's `ADR` ending one comment line and `0014`
// opening the next.
//
// Beyond the patterns ADR 0019 measured with, these forms of the same banned
// things, each measured on the swept tree before landing:
//   - `-` is NOT in the bare `#N` lookbehind. ADR 0019's scan excluded it, and
//     on the swept tree that hid exactly two citations (`Pre-#760`,
//     `pre-#1066`) and no false positive.
//   - `name#N` unqualified (`PR#346`, `oh-my-pi#12`), which the bare
//     lookbehind skips because a word character precedes the `#`. Its only
//     hits were ledger-syntax examples spelled with concrete PR numbers.
//     `${var#12}` (shell prefix removal) is exempt.
//   - a github.com issue or pull URL. No hits.
//   - `ADR-NNNN` and `ADRs NNNN`. One hit, a real citation (`pre-ADR-0015`).
// Left out on purpose: `docs/components/` and `tests/` paths, which ADR 0019's
// enumerated list does not name; widening the rule is the maintainer's call.
//
// THE ONE CARVE-OUT is ADR 0019's: CSS hex colours in board.html, and only
// inside its `<style>` element, in a declaration's value. A colour anywhere
// else — another file, board.html's script, a CSS comment, a selector, a quoted
// string or a `url(...)` inside a value — is scanned like any text. No
// allowlist and no per-line opt-out marker, by the same ruling.
//
// Beside citation-sweep-prose.test.mjs, not inside it: that file is a table of
// per-file stale/live spelling pairs over code files in `plugin/` and `tests/`;
// this one is a pattern ban over every file type in `plugin/` only, with no
// table at all. Its own source is under `tests/`, outside its sweep, so it
// cites freely and needs no assembled-from-parts pattern for a self-scan.
//
// repo-root.mjs's `trackedPaths`, not a directory walk, for the reason
// scripts-path-citation-sweep.test.mjs gives: an untracked scratch file is
// never an offender, and a tracked file leaves the sweep with `plugin/`.
// Without an ambient `.git` the tree tests DECLINE with a reason.
//
// Zero deps: `node --test tests/shipped-surface-prose.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, skipWithoutRepo, trackedPaths } from "../plugin/scripts/repo-root.mjs";

const ROOT = repoRoot(fileURLToPath(new URL("../plugin/scripts", import.meta.url)));
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "the shipped-surface reference scan of plugin/");
const FILES = ROOT === null ? [] : trackedPaths(ROOT, ["plugin"]);
const readRel = (relPath) => readFileSync(join(ROOT, relPath), "utf8");

const BOARD_HTML = "plugin/scripts/board.html";
const REVIEW_CORE = "plugin/scripts/review-core.mjs";
const RUN_TEAM_SKILL = "plugin/skills/run-team/SKILL.md";
const CLAIM_TICKET = "plugin/scripts/claim-ticket.sh";

// Horizontal whitespace, or one line break with the next line's comment
// gutter — the wrap a `PR` / `ADR` and its number may straddle.
const GAP = String.raw`(?:[ \t]+|[ \t]*\r?\n[ \t]*(?:\/\/+|#+|\*+|>+)?[ \t]*)`;

// A dated spec, `spec 2026-09-24`, is `docs/specs/2026-09-24-*.md` with the
// directory elided; `spec § N` and the `§ N §M` rule pointer it spawns point
// into one. A `§` after a shipped or harness document's name is not one.
const SPEC_POINTER = String.raw`\b[Ss]pec(?:${GAP}\d{4}-\d{2}-\d{2}\b|${GAP}?§)|§${GAP}?\d+${GAP}?§${GAP}?\d+`;

const PATTERNS = [
  ["bare #N", String.raw`(?<![\w/&$])#\d{2,}`],
  ["owner/repo#N", String.raw`\b[\w.-]+\/[\w.-]+#\d+`],
  ["name#N", String.raw`(?<!\$\{)\b[A-Za-z][\w.-]*#\d{2,}`],
  ["issue or PR URL", String.raw`\bgithub\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+`],
  ["PR N", String.raw`\bPRs?${GAP}\d{2,}\b`],
  ["ADR NNNN", String.raw`\bADRs?(?:-|${GAP})?\d{3,4}\b`],
  ["docs/ record path", String.raw`\bdocs\/(?:adr|specs|research|agents|requirements)\b`],
  ["test-file name", String.raw`[\w.-]+\.test\.mjs\b`],
  ["spec-section pointer", SPEC_POINTER],
].map(([kind, source]) => [kind, new RegExp(source, "g")]);

// A CSS hex colour: 3, 4, 6 or 8 hex digits, ending at a non-name character.
const CSS_HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

// What the style scan steps over untouched: a CSS comment, a quoted string, a
// `url(...)`. Each may hold a `;`, `{`, `}` or `:` that is not CSS syntax.
const CSS_OPAQUE = String.raw`\/\*[\s\S]*?\*\/|"[^"]*"|'[^']*'|url\([^)]*\)`;

// A run of style text up to the next `;`, `{` or `}` and that terminator.
const CSS_SEGMENT = new RegExp(String.raw`((?:${CSS_OPAQUE}|[^;{}])*)([;{}]?)`, "g");
const CSS_VALUE_TOKEN = new RegExp(`${CSS_OPAQUE}|:|${CSS_HEX.source}`, "g");

// One declaration: blank each hex colour after its first `:`, outside any
// comment, string or `url(...)`.
function blankValueColours(declaration) {
  let inValue = false;
  return declaration.replace(CSS_VALUE_TOKEN, (token) => {
    if (token === ":") inValue = true;
    return inValue && token.startsWith("#") ? " ".repeat(token.length) : token;
  });
}

/**
 * board.html's text with every CSS hex colour in a `<style>` declaration value
 * replaced by spaces of the same length, so offsets and line numbers hold. Only
 * a segment ended by `;` or `}` is a declaration: one ended by `{` is a
 * selector or at-rule prelude, so `a:hover #1234 {` blanks nothing. A CSS
 * comment, a quoted string and a `url(...)` are skipped over untouched — a
 * reference inside one is scanned.
 */
export function blankStyleColours(text) {
  return text.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, body, close) =>
    open
    + body.replace(CSS_SEGMENT, (_segment, run, end) => (end === "{" ? run : blankValueColours(run)) + end)
    + close);
}

/** Every banned reference in `text`, read as the tracked file `relPath`. */
export function offences(relPath, text) {
  const scanned = relPath === BOARD_HTML ? blankStyleColours(text) : text;
  const found = [];
  for (const [kind, pattern] of PATTERNS) {
    for (const m of scanned.matchAll(pattern)) {
      const line = scanned.slice(0, m.index).split("\n").length;
      found.push({ relPath, line, kind, match: m[0] });
    }
  }
  return found.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
}

const describe = (list) => list.map((o) => `${o.relPath} line ${o.line} (${o.kind}): ${JSON.stringify(o.match)}`).join("\n");

// Index of the first line `predicate` accepts; fails loudly when none does,
// so a mutation below can never pass by having nowhere to land.
function lineWhere(lines, predicate, what) {
  const i = lines.findIndex(predicate);
  assert.ok(i >= 0, `no line is ${what} — the mutation has nowhere to land`);
  return i;
}

// The scan of `relPath` after `mutate` rewrites line `i`: must report a new
// offence ON that line, where the unmutated file reports none at all.
function assertMutationReds(relPath, text, i, mutate) {
  const lines = text.split("\n");
  const before = offences(relPath, text);
  lines[i] = mutate(lines[i]);
  const after = offences(relPath, lines.join("\n"));
  assert.deepEqual(before, [], `${relPath} is not clean before mutation:\n${describe(before)}`);
  assert.ok(
    after.some((o) => o.line === i + 1),
    `${relPath} line ${i + 1} mutated to ${JSON.stringify(lines[i])} and the scan did not see it`,
  );
}

test("the scan sees the shipped tree, mutation targets included", { skip: SKIP_WITHOUT_REPO }, () => {
  assert.ok(FILES.length > 50, `trackedPaths(ROOT, ["plugin"]) returned only ${FILES.length} paths — too few to be the shipped tree`);
  for (const relPath of [BOARD_HTML, REVIEW_CORE, RUN_TEAM_SKILL, CLAIM_TICKET]) {
    assert.ok(FILES.includes(relPath), `${relPath} is not among the tracked plugin/ files`);
  }
  for (const ext of [".md", ".mjs", ".sh", ".json", ".html"]) {
    assert.ok(FILES.some((f) => f.endsWith(ext)), `no tracked ${ext} under plugin/ — the scan is not reading every file type`);
  }
});

test("no tracked file under plugin/ names an issue, PR, ADR, docs/ record or test file", { skip: SKIP_WITHOUT_REPO }, () => {
  const found = FILES.flatMap((relPath) => offences(relPath, readRel(relPath)));
  assert.deepEqual(found, [], `shipped files name what does not ship — state the claim instead and put the reference in the commit:\n${describe(found)}`);
});

test("a (#1234) in a comment of every plugin/scripts/*.mjs turns the scan red", { skip: SKIP_WITHOUT_REPO }, () => {
  const scripts = FILES.filter((f) => /^plugin\/scripts\/[^/]+\.mjs$/.test(f));
  assert.ok(scripts.length > 20, `only ${scripts.length} plugin/scripts/*.mjs found`);
  for (const relPath of scripts) {
    const text = readRel(relPath);
    const i = lineWhere(text.split("\n"), (l) => /^\s*(?:\/\/|\*)\s*\S/.test(l), `a comment line in ${relPath}`);
    assertMutationReds(relPath, text, i, (l) => `${l} (#1234)`);
  }
});

test("a (#1234) in a review-core.mjs prompt literal turns the scan red", { skip: SKIP_WITHOUT_REPO }, () => {
  const text = readRel(REVIEW_CORE);
  const i = lineWhere(text.split("\n"), (l) => l.includes('prompt: "'), "a `prompt: \"…\"` literal");
  assertMutationReds(REVIEW_CORE, text, i, (l) => l.replace('prompt: "', 'prompt: "(#1234) '));
});

test("a (#1234) in run-team/SKILL.md prose turns the scan red", { skip: SKIP_WITHOUT_REPO }, () => {
  const text = readRel(RUN_TEAM_SKILL);
  const lines = text.split("\n");
  // Past the frontmatter, so the line is body prose rather than a YAML key.
  const bodyStart = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
  assert.ok(bodyStart > 0 || lines[0] !== "---", `${RUN_TEAM_SKILL}'s frontmatter never closes`);
  const i = lineWhere(lines, (l, n) => n >= bodyStart && /^[A-Za-z]/.test(l), "a body prose line");
  assertMutationReds(RUN_TEAM_SKILL, text, i, (l) => `${l} (#1234)`);
});

test("a spec 2026-09-24 § 6 pointer in every plugin/scripts/*.mjs comment and plugin/skills/ markdown file turns the scan red", { skip: SKIP_WITHOUT_REPO }, () => {
  const scripts = FILES.filter((f) => /^plugin\/scripts\/[^/]+\.mjs$/.test(f));
  assert.ok(scripts.length > 20, `only ${scripts.length} plugin/scripts/*.mjs found`);
  for (const relPath of scripts) {
    const text = readRel(relPath);
    const i = lineWhere(text.split("\n"), (l) => /^\s*(?:\/\/|\*)\s*\S/.test(l), `a comment line in ${relPath}`);
    assertMutationReds(relPath, text, i, (l) => `${l} (spec 2026-09-24 § 6)`);
  }
  const skills = FILES.filter((f) => /^plugin\/skills\/.+\.md$/.test(f));
  assert.ok(skills.includes(RUN_TEAM_SKILL), `${RUN_TEAM_SKILL} is not among the plugin/skills/ markdown files`);
  for (const relPath of skills) {
    const text = readRel(relPath);
    const lines = text.split("\n");
    const bodyStart = lines[0] === "---" ? lines.indexOf("---", 1) + 1 : 0;
    const i = lineWhere(lines, (l, n) => n >= bodyStart && /^[A-Za-z]/.test(l), `a body prose line in ${relPath}`);
    assertMutationReds(relPath, text, i, (l) => `${l} (spec 2026-09-24 § 6)`);
  }
});

test("a spec 2026-09-24 § 6 pointer wrapped across a comment line break turns the scan red", { skip: SKIP_WITHOUT_REPO }, () => {
  const relPath = "plugin/scripts/fleet-tick.mjs";
  const text = readRel(relPath);
  const i = lineWhere(text.split("\n"), (l) => /^\/\/ \S/.test(l), `a comment line in ${relPath}`);
  assertMutationReds(relPath, text, i, (l) => `${l} (spec\n// 2026-09-24 § 6)`);
  assertMutationReds(relPath, text, i, (l) => `${l} (§ 6\n// §5)`);
});

test("' — ADR 0015' restored inside claim-ticket.sh's rederive string and a die string turns the scan red", { skip: SKIP_WITHOUT_REPO }, () => {
  const text = readRel(CLAIM_TICKET);
  const lines = text.split("\n");
  const rederive = lineWhere(lines, (l) => l.startsWith('rederive="') && l.includes("before the first claim)"), "the rederive assignment");
  assertMutationReds(CLAIM_TICKET, text, rederive, (l) => l.replace("before the first claim)", "before the first claim — ADR 0015)"));
  const dieLine = lineWhere(lines, (l) => /\bdie "[^"]*"\s*(?:;;)?\s*$/.test(l), "a one-line die string");
  assertMutationReds(CLAIM_TICKET, text, dieLine, (l) => l.replace(/"(\s*(?:;;)?\s*)$/, ' — ADR 0015"$1'));
});

test("every banned form is caught, a wrapped PR or ADR reference included", () => {
  const caught = [
    ["plugin/scripts/x.mjs", "// fixed in (#1234)", "bare #N"],
    ["plugin/scripts/x.sh", "# see pre-#760 for why", "bare #N"],
    ["plugin/x.md", "#12 at line start", "bare #N"],
    ["plugin/x.md", "see feigi/claude-config#903", "owner/repo#N"],
    ["plugin/x.md", "see oh-my-pi#412", "name#N"],
    ["plugin/x.md", "see oh-my-pi#12", "name#N"],
    ["plugin/scripts/x.mjs", "// the `→ PR#346` arrow", "name#N"],
    ["plugin/x.md", "https://github.com/feigi/fleet-plugin/pull/866", "issue or PR URL"],
    ["plugin/x.md", "https://github.com/feigi/fleet-plugin/issues/12", "issue or PR URL"],
    ["plugin/x.md", "measured on PR 866", "PR N"],
    ["plugin/x.md", "measured on PR 12", "PR N"],
    ["plugin/x.md", "measured on PRs 12", "PR N"],
    ["plugin/scripts/x.mjs", "// measured on PR\n// 866", "PR N"],
    ["plugin/x.md", "> measured on PR\n> 866", "PR N"],
    ["plugin/x.md", "per ADR 0015", "ADR NNNN"],
    ["plugin/x.md", "the pre-ADR-0015 bootstrap", "ADR NNNN"],
    ["plugin/x.md", "ADRs 0014 and", "ADR NNNN"],
    ["plugin/x.md", "per ADR 014", "ADR NNNN"],
    ["plugin/scripts/x.mjs", "  // per ADR\n  // 0015", "ADR NNNN"],
    ["plugin/scripts/x.mjs", "// per ADR\r\n// 0015", "ADR NNNN"],
    ["plugin/scripts/x.sh", "# per ADR\n#   0015", "ADR NNNN"],
    ["plugin/scripts/x.mjs", " * per ADR\n * 0015", "ADR NNNN"],
    ["plugin/x.md", "per ADR\n0015, which", "ADR NNNN"],
    ["plugin/x.md", "see docs/requirements.md §3.2", "docs/ record path"],
    ["plugin/x.md", "docs/adr/0019-x.md", "docs/ record path"],
    ["plugin/x.md", "docs/specs/x.md", "docs/ record path"],
    ["plugin/x.md", "docs/research/x.md", "docs/ record path"],
    ["plugin/x.md", "docs/agents/x.md", "docs/ record path"],
    ["plugin/scripts/x.sh", 'die "see claim-ticket.test.mjs"', "test-file name"],
    ["plugin/x.md", "`color:#30363d` outside board.html", "bare #N"],
    ["plugin/scripts/x.mjs", "// invocation (spec 2026-09-24 § 6: record, tick)", "spec-section pointer"],
    ["plugin/scripts/x.mjs", "// `model:` is `@<role>:<level>` (spec 2026-09-28).", "spec-section pointer"],
    ["plugin/scripts/x.mjs", "// The draw (spec § 2): uniform", "spec-section pointer"],
    ["plugin/scripts/x.mjs", "// Spec § 3 §7's result token", "spec-section pointer"],
    ["plugin/scripts/x.mjs", "// held until a replacement (§ 6 §6). The", "spec-section pointer"],
    ["plugin/scripts/x.mjs", "// the spec\n// 2026-09-24 § 6", "spec-section pointer"],
    ["plugin/x.md", "the spec §\n6 says", "spec-section pointer"],
    ["plugin/x.md", "≈ 1.95·I (spec 2026-09-24 § 3\n§3, medians", "spec-section pointer"],
  ];
  for (const [relPath, text, kind] of caught) {
    const found = offences(relPath, text);
    assert.ok(
      found.some((o) => o.kind === kind),
      `${JSON.stringify(text)} in ${relPath} not caught as ${kind}: ${describe(found)}`,
    );
  }
});

test("what the scan must accept: placeholders, interpolation, entities, shell, URL fragments, board.html colours", () => {
  const accepted = [
    ["plugin/scripts/x.mjs", "const t = `#${n}`; // `#${pr}` is filled in at run time"],
    ["plugin/x.md", "a `Blocked by: #N` ref, `PR#<n>`, `impl-<N>=PR#<n>`, `#M,#N`"],
    ["plugin/x.md", "a single digit: `#5`, `CI#1`, `PR 7`"],
    ["plugin/x.html", "&#39; and &#x27;"],
    ["plugin/scripts/x.sh", 'n="$#"; len=${#arr[@]}; tail=${var#12}; s=${x##*/}'],
    ["plugin/scripts/x.sh", "echo $#12"],
    ["plugin/x.md", "https://example.com/page/#12 and a/#34"],
    ["plugin/x.md", "`docs/metrics/tier-outcomes.tsv`, `docs/…` branches, a `*.test.mjs` glob"],
    ["plugin/x.md", "`plugin/package.json#omp.extensions`"],
    ["plugin/x.md", "PRs touch it; ADRs stay in the repo"],
    ["plugin/x.md", "#!/bin/sh"],
    [BOARD_HTML, "<style>\n  :root { --bg:#0d1117; --panel:#161b22; }\n  .a { color:#000; background: #2d1618 }\n</style>"],
    [BOARD_HTML, "<style>\n  .a { color:#00000080; background:#fff8 }\n</style>"],
    [BOARD_HTML, "<STYLE>\n  .a { color:#000000; }\n</STYLE>"],
    ["plugin/scripts/x.mjs", "//     § `agent()`), per omp://tools/eval.md"],
    ["plugin/scripts/fleet-run", "// The Resolver (CONTEXT.md § Install"],
    ["plugin/scripts/x.mjs", "// with `jq` (review-and-fix.md § The review result file), so"],
    ["plugin/scripts/x.mjs", "// dispatches the ticket (shortlist.mjs's own header, §3),"],
    ["plugin/x.md", "the spec says; a spec-compliant reader; inspect 2026-09-24"],
  ];
  for (const [relPath, text] of accepted) {
    assert.deepEqual(offences(relPath, text), [], `${JSON.stringify(text)} in ${relPath} was refused`);
  }
});

test("the board.html carve-out is a CSS declaration colour and nothing else", () => {
  const style = (body) => `<style>\n${body}\n</style>`;
  // Each text holds one `#1234` reference the carve-out must not hide.
  const red = [
    style("  /* the fix for #1234 */\n  .a { color:#000; }"),
    style("  .a { color: #000 /* see #1234 */; }"),
    style('  .a::after { content: "fixed in #1234"; }'),
    style("  .a::after { content: 'fixed in #1234'; color:#000; }"),
    style('  .a::after { content: "a; fixed in #1234"; }'),
    style("  .a:hover #1234 { color:#000; }"),
    style("  .a:hover, .b:focus #1234 /* x */ { color:#000; }"),
    style("  .a { #1234; color:#000; }"),
    `${style("  .a { color:#000; }")}\n<script>\n  // fixed in (#1234)\n</script>`,
    `${style("  .a { color:#000; }")}\n<p>see #1234</p>`,
  ];
  for (const text of red) {
    assert.ok(offences(BOARD_HTML, text).some((o) => o.match === "#1234"), `${JSON.stringify(text)} in board.html was not refused`);
  }
  // A `url(...)` fragment is scanned too: the digits are named, whatever kind.
  const url = style("  .a { background: url(x.svg#1234); }");
  assert.notDeepEqual(offences(BOARD_HTML, url), [], `${JSON.stringify(url)} in board.html was not refused`);
  // A run of digits or a hyphenated tail is not a colour, so it stays visible.
  for (const value of ["#12345", "#123456abc", "#123-x"]) {
    const text = style(`  .a { color:${value}; }`);
    assert.ok(offences(BOARD_HTML, text).some((o) => value.startsWith(o.match)), `${JSON.stringify(text)} in board.html was not refused`);
  }
  // The same colour declaration outside board.html is not carved out.
  assert.notDeepEqual(offences("plugin/scripts/other.html", style("  .a { color:#000; }")), []);
});
