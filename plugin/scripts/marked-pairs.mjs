// #1346, ruled on #1299/ADR 0004: the marked-pair divergence check's data
// layer. `prose-pin.mjs` pins ONE pair at a time, chosen by the caller
// (`between(text, from, to, ...)` plus `markedLine`); this module is the
// OTHER direction — walk the whole prose tree, find every Marked line
// (CONTEXT.md § Dialect: `^\s*(CLAUDE|OMP): ` once any gutter is stripped),
// pair each one with its adjacent partner, and classify + validate every
// pair with no per-pair knowledge at all. `marked-pairs.test.mjs` is the
// divergence-check instrument built on top of this file.
//
// SCOPE, decided here. `.md` under `skills/`, `commands/`, `agents/` — the
// three directories #1297/#1299's ruling calls "the prose tree" (ADR 0004's
// ~23 dispatch sites all live under these). `.js` under `workflows/` is ALSO
// in scope, for comment-form pairs: a Workflow script cannot `import`
// (measured, cited in `review-core.js`'s own header — the sandbox forbids
// it), so a marked pair that needs to exist inside `review-pr.js` cannot be
// prose at all, only a `//`-commented cross-reference. #1361 adds the first
// one (`resumeFor`'s `CLAUDE:`/`OMP:` comment beside its Claude-only
// message) — verified absent from `workflows/` as of this file's writing
// (2026-09-09, pre-#1361 merge), so real-tree coverage of that directory is
// currently a scan of zero pairs, not a guess about their shape. `docs/` is
// deliberately OUT: #1299's ruling and CONTEXT.md's own inventory scope the
// pair discipline to agent-executed prose, and `docs/` is read by humans,
// never dispatched.
//
// ADJACENCY, measured against every real pair landed by #1341/#1344: a
// Marked line's partner is the line immediately following it (line N, N+1)
// after gutter-stripping — never separated by a blank line, never a
// section-bounded search. Checked against all nine real pairs currently in
// the tree (five in `member-lifecycle.md`, four restated/original in
// `run-team/SKILL.md`, including the one embedded inside a `>` blockquote at
// SKILL.md's fix-applier prompt) — every one is two consecutive physical
// lines. `pairFile` below never looks past N+1 for a partner, so a marker
// separated from its partner by so much as a blank line is an orphan, named.
//
// PAIRING is per FILE, never a whole-tree line count: `scanTree` returns
// markers grouped by file, and `pairFile` runs once per file's own list, so
// the last marker of one file can never pair with the first marker of the
// next — the same file-boundary discipline #1346's fixture test (in
// `marked-pairs.test.mjs`) exists to prove for the coordination pins
// themselves (#1299's "resume"/"truncated" collision).
//
// CLASSIFICATION heuristic: a pair is `does-not-apply` if exactly one of its
// two lines contains the literal phrase "does not apply" (case-insensitive).
// This is not invented — it is the wording #1341's landed prose actually
// uses, grepped before picking it (`member-lifecycle.md`: "the tail/jq
// recipe does not apply", "the lost-if-unconsumed hazard does not apply" —
// both omp lines, both this exact phrase, no variant). #1299's ruling names
// the requirement ("the omp line contains the explicit 'does not apply on
// omp' form") without giving the literal string; this is that string, pinned
// in CONTEXT.md § Dialect's Pair entry so a future author has one fixed
// spelling to write, not a phrase to reinvent per pair. A pair with the
// phrase on BOTH lines is `invalid`, not `does-not-apply` — nothing states
// the rule on either harness, which is its own defect, not a pair shape.
//
// EQUALITY, for `same-rule` pairs: `normalizeDialect` finds every backtick
// code span in a line, and — if the span's content matches either side of a
// `DIALECT_TOKENS` entry (prose-pin.mjs) — replaces the WHOLE span with that
// entry's placeholder, after first stripping any `` `fleet-ctl: `` prefix (the
// agent-name convention CONTEXT.md's Pair entry names as a dialect token in
// its own right: `` `fleet-ctl:fleet-implementer` `` and `` `fleet-implementer` ``
// normalize to the same span). Two lines are `same-rule`-equal iff their
// normalized, whitespace-collapsed forms are identical.
//
// THE MEASURED GAP this equality bar finds on the real tree, and why it is
// not closed by loosening the check: #1299's ruling text says a same-rule
// pair's lines "differ only in the dialect tokens... normalised comparison
// after stripping the tool names and agent-name conventions." Run against
// the real tree (`marked-pairs.test.mjs`'s real-tree test), ALL SIX same-rule
// pairs currently in the tree — Wake and Settle/liveness (each stated once
// in `member-lifecycle.md` and restated in SKILL.md), Receipts, and the
// worktree/claim-model cwd recipe — fail literal equality after this
// normalization; the three does-not-apply pairs all pass cleanly. Each
// omp line carries its own measured supporting detail (`hub cancel` →
// `cancelled`, the 16-hex message id, the two-axis state machine, the
// `task` item-schema field list) that has no Claude-side counterpart
// sentence to normalize against — independently elaborated content, not a
// token substituted for another token. This is a real finding against
// already-merged, already mutation-tested prose (#1341, #1344, #1360's
// review), not a bug in this file's token table — mutation-testing the
// check itself against a controlled fixture (below, and
// `marked-pairs.test.mjs`) confirms the mechanism does distinguish
// inversion and token-swap from a benign reword; it is the specific bar of
// "differ ONLY in dialect tokens" that every real same-rule pair misses,
// 6/6. Filed as #1362 rather than silently loosened or silently rewriting
// reviewed, mutation-tested prose out from under its own pins; the pairs
// are named as `KNOWN_EQUALITY_EXCEPTIONS` below, each carrying that issue
// number, so the exception is visible and bounded rather than absorbed
// into the check's normal-case tolerance — a NEW same-rule pair that fails
// this bar is not grandfathered in by adding itself to this list.
//
// THE SECOND, INDEPENDENT check every same-rule pair must ALSO pass:
// `foreignTokens(text, otherHarness)` — neither line may contain a
// recognized token from the OTHER harness's side of `DIALECT_TOKENS`. This
// is what actually catches #1299's run-4 mutant (the two lines' tool tokens
// swapped in place): after a swap, `normalizeDialect` alone would still
// report the two lines equal (both sides' tokens map to the same
// placeholder regardless of which line carries which), so equality cannot be
// the whole check — only the foreign-token test reds on a swap, and it
// passes on every real pair today (verified: none of the nine real pairs
// names the other harness's tool inside its own line).
//
// MUTATION PROCEDURE (#1299's four runs, one mutant applied to ONE copy at a
// time, never both — applying to both is exactly the edit the divergence
// check cannot distinguish from a legitimate one). Run against a scratch
// copy of this repo (never the real checkout), preserving the path depth
// this file's own `REPO`-relative reads assume:
//
//   1. Mutate the Claude line (invert/delete). The pair's own per-line pin
//      (wherever one exists, e.g. `member-lifecycle-dialect-prose.test.mjs`)
//      must fail; THIS file's divergence check must fail too — UNLESS the
//      pair is already a `KNOWN_EQUALITY_EXCEPTIONS` entry, in which case
//      inversion alone (no foreign token introduced) is invisible to it:
//      measured for real on the Wake pair below, not theorized. A pair NOT
//      on that list has no such gap — its equality check is live, so
//      inversion breaks it directly.
//   2. Mutate the omp line symmetrically. Same outcome, mirrored.
//   3. Benign reword of the shared sentence ABOVE the pair (whitespace,
//      synonym outside the two marked lines). Every check in this file stays
//      green — the marked lines themselves are untouched, so adjacency,
//      classification, equality and foreign-token all see the same input.
//   4. Swap the two lines' tokens (Claude's line renamed to name omp's tool,
//      omp's line renamed to name Claude's). Both lines' own pins fail on
//      their `doesNotMatch`; THIS file's `foreignTokens` check fails on
//      both lines regardless of whether the pair is an equality exception —
//      the one mutant this check catches even on an exempted pair, because
//      the exception is scoped to equality alone (`checkPair`'s
//      `exemptViolations` split).
//
// `marked-pairs.test.mjs` records one real run of all four, on the Wake pair
// (member-lifecycle.md:32-33 — already a `KNOWN_EQUALITY_EXCEPTIONS` entry,
// which is what exposed run 1/2's gap above), in its own comments, with the
// actual pass/fail counts observed on a scratch copy.

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { DIALECT_TOKENS, stripQuoteGutter, stripSlashGutter } from "./prose-pin.mjs";

export { DIALECT_TOKENS };

// The marker grammar CONTEXT.md § Dialect fixes: `CLAUDE: `/`OMP: ` as a
// line's first token once its gutter is stripped. Captures the harness and
// everything after the label, so callers never re-split the "`CLAUDE: `"
// prefix off themselves.
export const MARKER_RE = /^\s*(CLAUDE|OMP): (.*)$/;

// Grepped, not invented — see this file's header. Both landed instances use
// this exact phrase; pinned in CONTEXT.md § Dialect's Pair entry too.
export const DOES_NOT_APPLY_RE = /does not apply/i;

export const MD_DIRS = ["skills", "commands", "agents"];
export const JS_DIRS = ["workflows"];

// #1362 (filed by this ticket): every same-rule pair currently in the tree
// (6/6, see this file's header) does not satisfy literal
// equality-after-normalization. Named by file + the CLAUDE line's 1-based
// line number in the GUTTER-STRIPPED text `pairFile` reports against (none
// of these six sit inside a `>` blockquote, so it also matches the raw
// source here), so an entry here can be matched against a real failure by
// eye. A pair not on this list must pass; this list must never be widened
// by a future pair simply failing the same way — that is a new finding,
// filed separately, never silently folded in here.
export const KNOWN_EQUALITY_EXCEPTIONS = [
  { file: join("skills", "run-team", "references", "member-lifecycle.md"), claudeLine: 32, issue: 1362, why: "Wake pair: omp line's re-dispatch/auto-suffix detail has no Claude-side counterpart clause" },
  { file: join("skills", "run-team", "references", "member-lifecycle.md"), claudeLine: 49, issue: 1362, why: "Receipts pair: omp line's native delivered/failed receipt detail has no Claude-side counterpart clause" },
  { file: join("skills", "run-team", "references", "member-lifecycle.md"), claudeLine: 60, issue: 1362, why: "Settle/liveness pair: two genuinely different state machines, not a token swap of one" },
  { file: join("skills", "run-team", "SKILL.md"), claudeLine: 87, issue: 1362, why: "Wake pair, restated in SKILL.md's Fresh-context-per-member passage" },
  { file: join("skills", "run-team", "SKILL.md"), claudeLine: 2182, issue: 1362, why: "Worktree/claim-model cwd recipe (#1344): omp line's item-schema field list and measured-gap detail has no Claude-side counterpart clause" },
  { file: join("skills", "run-team", "SKILL.md"), claudeLine: 2472, issue: 1362, why: "Settle/liveness pair, restated in SKILL.md's Failure-handling passage" },
];

function isExempt(pair) {
  return KNOWN_EQUALITY_EXCEPTIONS.some((e) => e.file === pair.file && e.claudeLine === pair.claudeLine);
}

function walk(dir) {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
  } catch {
    // A directory that does not exist yet (e.g. a fixture tree missing one
    // of the three md dirs) contributes no files rather than throwing —
    // callers that need every dir present assert that separately.
    return [];
  }
}

function gutterStrip(ext, text) {
  if (ext === ".md") return stripQuoteGutter(text);
  if (ext === ".js") return stripSlashGutter(text);
  return text;
}

// Every Marked line in one file, in file order, 1-based line numbers counted
// against the GUTTER-STRIPPED text — the same text the marker regex runs
// against, so a line number this returns always indexes the line that
// actually carries the marker, blockquote `>` or not.
export function scanFile(root, absPath) {
  const ext = extname(absPath);
  const raw = readFileSync(absPath, "utf8");
  const stripped = gutterStrip(ext, raw);
  const file = relative(root, absPath);
  const markers = [];
  stripped.split("\n").forEach((line, idx) => {
    const m = line.match(MARKER_RE);
    if (m) markers.push({ file, line: idx + 1, harness: m[1], text: m[2] });
  });
  return markers;
}

function listFiles(root) {
  const md = MD_DIRS.flatMap((d) => walk(join(root, d)).filter((f) => extname(f) === ".md"));
  const js = JS_DIRS.flatMap((d) => walk(join(root, d)).filter((f) => extname(f) === ".js"));
  return [...md, ...js].sort();
}

// Markers for every in-scope file under `root`, grouped by file (never
// concatenated across files — see this file's header on why that matters).
export function scanTree(root) {
  return listFiles(root).map((f) => ({ file: relative(root, f), markers: scanFile(root, f) }));
}

// Pairs ONE file's markers (already in file order) into adjacent CLAUDE/OMP
// pairs. Everything not consumed by a valid pair is an orphan, named by
// file + line + harness + a reason. Greedy left-to-right: a valid pair
// (opposite harnesses, consecutive lines) always wins over treating either
// line as an orphan, so a duplicate marker next to a real pair is reported
// as the duplicate, not as a false break in the pair beside it.
export function pairFile(markers) {
  const pairs = [];
  const orphans = [];
  let i = 0;
  while (i < markers.length) {
    const a = markers[i];
    const b = markers[i + 1];
    if (b && b.line === a.line + 1 && b.harness !== a.harness) {
      const claude = a.harness === "CLAUDE" ? a : b;
      const omp = a.harness === "OMP" ? a : b;
      pairs.push({
        file: a.file,
        claudeLine: claude.line,
        ompLine: omp.line,
        claude: claude.text,
        omp: omp.text,
      });
      i += 2;
    } else {
      const dup = b && b.line === a.line + 1 && b.harness === a.harness;
      orphans.push({
        file: a.file,
        line: a.line,
        harness: a.harness,
        text: a.text,
        reason: dup
          ? `duplicate ${a.harness} marker: two adjacent ${a.harness} lines with no ${a.harness === "CLAUDE" ? "OMP" : "CLAUDE"} between them`
          : "no adjacent partner marker (partner must be the very next line)",
      });
      i += 1;
    }
  }
  return { pairs, orphans };
}

// Runs `pairFile` per file over a whole `scanTree` result, tagging every
// orphan/pair with its originating file (already present on each row, kept
// here only as the one place callers reach for "the whole tree's pairs").
export function pairTree(root) {
  const pairs = [];
  const orphans = [];
  for (const { markers } of scanTree(root)) {
    const r = pairFile(markers);
    pairs.push(...r.pairs);
    orphans.push(...r.orphans);
  }
  return { pairs, orphans };
}

// `same-rule` | `does-not-apply` | `invalid` (both lines claim
// non-applicability — a defect, not a third pair shape).
export function classifyPair(pair) {
  const claudeDNA = DOES_NOT_APPLY_RE.test(pair.claude);
  const ompDNA = DOES_NOT_APPLY_RE.test(pair.omp);
  if (claudeDNA && ompDNA) return "invalid";
  if (claudeDNA || ompDNA) return "does-not-apply";
  return "same-rule";
}

// Widens a token hit to its WHOLE enclosing backtick span before replacing
// with a placeholder — see this file's header for why (a token regex like
// `` /`hub\b/ `` only anchors the span's opening word; `` `hub send` `` and
// `` `hub cancel` `` must normalize to the SAME placeholder, not leave their
// tails behind to break equality on a difference that isn't dialect at all).
export function normalizeDialect(text) {
  let out = text.replace(/`fleet-ctl:/g, "`");
  out = out.replace(/`[^`]*`/g, (span) => {
    for (const { name, claude, omp } of DIALECT_TOKENS) {
      if (claude.test(span) || omp.test(span)) return `<${name}>`;
    }
    return span;
  });
  return out.trim().replace(/\s+/g, " ");
}

// Recognized tokens belonging to `harness` (the OTHER harness, from a line's
// point of view) found inside `text`. A non-empty result on a line is always
// a defect: the line's own harness needs none of its own name checked here
// (equality/content pins do that), only that it carries none of the
// partner's.
export function foreignTokens(text, harness) {
  const side = harness === "CLAUDE" ? "claude" : "omp";
  return DIALECT_TOKENS.filter((t) => t[side].test(text)).map((t) => t.name);
}

// One pair's full verdict: violations is empty iff the pair is clean.
// `exempt: true` marks a pair on `KNOWN_EQUALITY_EXCEPTIONS` — its equality
// violation (only) is downgraded from the returned `violations` list into
// `exemptViolations`, so a caller can assert the exception list is doing
// exactly what it claims and nothing more (foreign-token violations are
// NEVER exempted; the exception list is scoped to the one measured gap).
export function checkPair(pair) {
  const kind = classifyPair(pair);
  const violations = [];
  const exemptViolations = [];
  const exempt = isExempt(pair);

  const claudeForeign = foreignTokens(pair.claude, "OMP");
  const ompForeign = foreignTokens(pair.omp, "CLAUDE");
  if (claudeForeign.length) violations.push(`${pair.file}:${pair.claudeLine}: CLAUDE line carries omp token(s): ${claudeForeign.join(", ")}`);
  if (ompForeign.length) violations.push(`${pair.file}:${pair.ompLine}: OMP line carries Claude token(s): ${ompForeign.join(", ")}`);

  if (kind === "invalid") {
    violations.push(`${pair.file}:${pair.claudeLine}-${pair.ompLine}: both lines say "does not apply" — neither states the rule`);
  } else if (kind === "same-rule") {
    const eq = normalizeDialect(pair.claude) === normalizeDialect(pair.omp);
    if (!eq) {
      const msg = `${pair.file}:${pair.claudeLine}-${pair.ompLine}: same-rule pair is not equal after stripping dialect tokens`;
      if (exempt) exemptViolations.push(msg);
      else violations.push(msg);
    }
  }
  // does-not-apply pairs need no further check here: classifyPair already
  // required exactly one line to carry the phrase.

  return { kind, exempt, violations, exemptViolations };
}
