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
// prose at all, only a comment cross-reference. #1361 landed the first one:
// `resumeFor`'s `CLAUDE:`/`OMP:` lines sit as two BARE lines (no `//` gutter
// at all) inside a `/* ... */` block comment (`workflows/review-pr.js`,
// `resumeFor`'s doc block) — `stripSlashGutter` (prose-pin.mjs) exists for a
// future single-line `// CLAUDE: ...` comment, not this instance; the block
// form needs no gutter stripped because `gutterStrip` runs it through
// unchanged and the bare marker is already the line's first token. `docs/`
// is deliberately OUT: #1299's ruling and CONTEXT.md's own inventory scope
// the pair discipline to agent-executed prose, and `docs/` is read by
// humans, never dispatched.
//
// FENCED CODE BLOCKS are NOT special-cased — a ` ``` ` fence is not tracked,
// so a `CLAUDE:`/`OMP:` pair written as a markdown CODE EXAMPLE (illustrating
// the marker grammar itself, say) is scanned, paired and checked exactly
// like real prose. Decided, not merely unhandled: an example is a pair, so
// write examples clean rather than teaching this scanner to look away from
// them — the alternative (skip anything inside a fence) would also hide a
// REAL pair mistakenly indented into a fence by a stray triple-backtick
// elsewhere in the file, which is a worse failure mode than an intentionally
// illustrative example needing to satisfy the same bar as real prose. No
// real instance exists in the tree today (verified against all 13 real
// pairs, 2026-09-09).
//
// ADJACENCY, measured against every real pair landed by #1341/#1344/#1361: a
// Marked line's partner is the line immediately following it (line N, N+1)
// after gutter-stripping — never separated by a blank line, never a
// section-bounded search. Checked against all 14 real pairs currently in the
// tree (five in `member-lifecycle.md`; six restated/original in
// `run-team/SKILL.md`, including the one embedded inside a `>` blockquote at
// SKILL.md's fix-applier prompt; two in `commands/review-and-fix.md`; one
// bare-in-block-comment pair in `workflows/review-pr.js`) — every one is two
// consecutive physical lines. `pairFile` below never looks past N+1 for a
// partner, so a marker separated from its partner by so much as a blank
// line is an orphan, named.
//
// PAIRING is per FILE, never a whole-tree line count: `scanTree` returns
// markers grouped by file, and `pairFile` runs once per file's own list, so
// the last marker of one file can never pair with the first marker of the
// next — the same file-boundary discipline #1346's fixture test (in
// `marked-pairs.test.mjs`) exists to prove for the coordination pins
// themselves (#1299's "resume"/"truncated" collision).
//
// CLASSIFICATION heuristic: a pair is `does-not-apply` if exactly one of its
// two lines matches `DOES_NOT_APPLY_RE` — two recognized, grepped (not
// invented) idioms, not one: the literal phrase "does not apply"
// (`member-lifecycle.md`: "the tail/jq recipe does not apply", "the
// lost-if-unconsumed hazard does not apply" — both omp lines, both this
// exact phrase originally), and "has no slot for" — added on Review1363's
// finding that the Settle/liveness pair (`member-lifecycle.md:60-61`,
// restated `SKILL.md:2477-2478`) states an absence in this second wording
// ("a bucket Claude's triad has no slot for") and was being absorbed into
// `KNOWN_EQUALITY_EXCEPTIONS` as a same-rule pair instead of recognized for
// what it is. Verified exactly two real instances of "has no slot for"
// (both this pair and its restatement), zero collisions elsewhere in the
// tree, before widening. #1299's ruling names the requirement ("the omp
// line contains the explicit 'does not apply on omp' form") without giving
// a literal string; both recognized idioms are pinned in CONTEXT.md §
// Dialect's Pair entry, so a future author has fixed spellings to write, not
// phrases to reinvent per pair. A pair with a recognized idiom on BOTH lines
// is `invalid`, not `does-not-apply` — nothing states the rule on either
// harness, which is its own defect, not a pair shape.
//
// EQUALITY, for `same-rule` pairs: `normalizeDialect(text, file)` finds
// every backtick code span in a line, and — if the span's content matches
// either side of a `DIALECT_TOKENS` entry (prose-pin.mjs) — replaces the
// WHOLE span with that entry's placeholder, after first stripping any
// `` `fleet-ctl: `` prefix (the agent-name convention CONTEXT.md's Pair
// entry names as a dialect token in its own right: `` `fleet-ctl:fleet-implementer` ``
// and `` `fleet-implementer` `` normalize to the same span). `file` disables
// exactly one entry's omp side inside `workflows/` — see DISAMBIGUATION
// below. Two lines are `same-rule`-equal iff their normalized,
// whitespace-collapsed forms are identical.
//
// DISAMBIGUATION: the `dispatch field` entry's omp token, `` `agent( ``,
// false-positives inside `workflows/*.js` — `review-pr.js` names its OWN
// Claude-side Workflow-script builtin with the identical spelling (ADR
// 0004's own caution: "no dialect rewrite may substitute on that spelling
// alone"), which the token table did not actually honor before Review1363
// measured it (`foreignTokens("dispatch via \`agent({...})\` here", "OMP")`
// returned `['dispatch field']` for a synthetic CLAUDE-line-shaped string).
// `normalizeDialect`/`foreignTokens` both take `file` and skip the omp side
// of `dispatch field` when `file` starts with `workflows/` — the one
// directory where the ambiguity is real; `.md` prose never names Claude's
// Workflow builtin by that token, so the guard is scoped as narrowly as the
// hazard.
//
// THE MEASURED GAP this equality bar finds on the real tree, and why it is
// not closed by loosening the check: #1299's ruling text says a same-rule
// pair's lines "differ only in the dialect tokens... normalised comparison
// after stripping the tool names and agent-name conventions." Run against
// the real tree (`marked-pairs.test.mjs`'s real-tree test), EIGHT same-rule
// pairs currently in the tree fail literal equality after this
// normalization: Wake (`member-lifecycle.md`, restated `SKILL.md`),
// Receipts, the worktree/claim-model cwd recipe (#1344), the review-path
// default statement (`review-and-fix.md`, restated `SKILL.md`, #1361),
// `review-pr.js`'s `resumeFor` cross-reference (#1361), and the implementer
// refill pair at phase 2's dispatch site (#1590). One pair
// (`review-and-fix.md:8-9`, the `fleet-review-<key>` agent-name pair)
// passes cleanly — the `fleet-ctl:` strip alone closes that gap, proving
// normalization is not vacuous. The five does-not-apply pairs all pass
// cleanly too (widened from three: the CLASSIFICATION section above moved two
// Settle/liveness pairs out of same-rule). Each failing omp line carries
// its own measured supporting detail (`hub cancel` → `cancelled`, the
// 16-hex message id, the `task` item-schema field list, the Resolver
// invocation recipe) that has no Claude-side counterpart sentence to
// normalize against — independently elaborated content, not a token
// substituted for another token. This is a real finding against
// already-merged, already mutation-tested prose (#1341, #1344, #1361,
// #1360's review), not a bug in this file's token table — mutation-testing
// the check itself against a controlled fixture (below, and
// `marked-pairs.test.mjs`) confirms the mechanism does distinguish
// inversion and token-swap from a benign reword; it is the specific bar of
// "differ ONLY in dialect tokens" that every real same-rule pair still
// misses, 8/8 as counted today (updated from 7/7 — #1590 landed the
// implementer-refill pair, whose omp line carries a pool mechanism the
// Claude line has no counterpart clause for; before it #1361 landed three
// more same-rule pairs restating the same review-path recipe, all added,
// and two pairs earlier counted here were reclassified as does-not-apply,
// see CLASSIFICATION above). Filed rather than silently loosened or
// silently rewriting reviewed, mutation-tested prose out from under its own
// pins; the pairs are named as `KNOWN_EQUALITY_EXCEPTIONS` below, each
// carrying the issue it was filed on — #1362 for the seven that predate it,
// #1590 for the eighth — so the exception is visible and bounded
// rather than absorbed into the check's normal-case tolerance — a NEW
// same-rule pair that fails this bar is not grandfathered in by adding
// itself to this list, and the list's own size is pinned by
// `marked-pairs.test.mjs`'s membership test so a silent addition reds it.
//
// THE SECOND, INDEPENDENT check every same-rule pair must ALSO pass:
// `foreignTokens(text, otherHarness, file)` — neither line may contain a
// recognized token from the OTHER harness's side of `DIALECT_TOKENS` (modulo
// the `file`-scoped `agent(` exception above). This is what actually
// catches #1299's run-4 mutant (the two lines' tool tokens swapped in
// place): after a swap, `normalizeDialect` alone would still report the two
// lines equal (both sides' tokens map to the same placeholder regardless of
// which line carries which), so equality cannot be the whole check — only
// the foreign-token test reds on a swap, and it passes on every real pair
// today (verified: none of the 14 real pairs names the other harness's tool
// inside its own line).
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
// prefix off themselves. `\r?` before `$`: CRLF-authored files split on
// `\n` (scanFile) leave a trailing `\r` on every line, which `.` (no `s`
// flag) does not consume and an un-flagged `$` then refuses to match past —
// `"CLAUDE: x\r".match(/^\s*(CLAUDE|OMP): (.*)$/)` is `null`. Measured on a
// fixture (one CRLF pair among LF pairs in the same file): without `\r?`
// the CRLF pair produced neither a pair nor an orphan — silently invisible,
// the one failure mode this instrument exists to prevent.
export const MARKER_RE = /^\s*(CLAUDE|OMP): (.*?)\r?$/;

// Grepped, not invented — see this file's header (CLASSIFICATION). Two
// recognized idioms: "does not apply" (both original landed instances) and
// "has no slot for" (added after Review1363's finding; exactly two real
// instances, zero collisions elsewhere in the tree, verified before
// widening).
export const DOES_NOT_APPLY_RE = /does not apply|has no slot for/i;

export const MD_DIRS = ["skills", "commands", "agents"];
export const JS_DIRS = ["workflows"];

// #1362/#1590: every same-rule pair currently in the tree that does not
// satisfy literal equality-after-normalization (8/8 as of this writing —
// #1362 filed the first seven, #1590 the eighth). Keyed by `file` + BOTH
// lines' EXACT text — CONTENT, never
// a line number. Review1363 measured why a line-number key fails: rebasing
// this branch onto #1361 shifted two of the six original entries (SKILL.md
// 2182→2187, 2472→2477 — #1361 inserts a pair earlier in the same file),
// which detached both exemptions and simultaneously reintroduced the same
// two pairs as unexempted equality failures — a numeric key breaks on any
// insertion ABOVE the pair, not just an edit to the pair itself. A content
// key survives that kind of shift and still fails loudly, exactly as
// desired, the moment the prose itself changes. BOTH lines, not just
// CLAUDE's: keying on the CLAUDE line alone (the first cut of this fix)
// left the OMP line free to change under an unchanged CLAUDE line and keep
// the exemption — measured directly, mutating the Wake pair's OMP line
// alone on a scratch copy stayed 18/18 green with the CLAUDE-only key,
// exactly the run-1/2 gap this exception list should not be able to hide a
// SECOND way. Either line changing now drops the match, which is the
// desired reaction: mutating either half of an exempted pair makes it
// re-surface as a real, unexempted equality failure until a human re-adds
// it deliberately with the new text. A pair not on this list must pass;
// this list must never be widened by a future pair simply failing the same
// way — that is a new finding, filed separately, never silently folded in
// here. Its own size is pinned by `marked-pairs.test.mjs`'s membership test
// (bidirectional: no stale entry, and no real failure left unlisted), so a
// silent addition or deletion reds the suite rather than passing quietly.
export const KNOWN_EQUALITY_EXCEPTIONS = [
  {
    file: join("skills", "run-team", "references", "member-lifecycle.md"),
    claude: "`SendMessage` to a finished agent resumes its transcript and drags the old ticket in — the wake this contract forbids for a refill.",
    omp: "`hub send` to an idle peer wakes it into its old transcript the same way; re-dispatching under the same name does not reset it — omp auto-suffixes a fresh peer (`name-2`) instead.",
    issue: 1362,
    why: "Wake pair: omp line's re-dispatch/auto-suffix detail has no Claude-side counterpart clause",
  },
  {
    file: join("skills", "run-team", "references", "member-lifecycle.md"),
    claude: "only the controller holds the message id, so only the controller detects the discrepancy — reconciliation is hand-rolled around a bare send.",
    omp: "`hub send` returns a structured `delivered`/`failed` receipt inline, replies thread by a 16-hex message id, and `await: true` returns the reply in the same call — the bookkeeping Claude hand-rolls is native.",
    issue: 1362,
    why: "Receipts pair: omp line's native delivered/failed receipt detail has no Claude-side counterpart clause",
  },
  {
    file: join("skills", "run-team", "SKILL.md"),
    claude: "`SendMessage` to a finished agent resumes its transcript and drags the old ticket in — the wake this contract forbids for a refill.",
    omp: "`hub send` to an idle peer wakes it into its old transcript the same way; re-dispatching under the same name does not reset it — omp auto-suffixes a fresh peer (`name-2`) instead.",
    issue: 1362,
    why: "Wake pair, restated in SKILL.md's Fresh-context-per-member passage",
  },
  {
    file: join("skills", "run-team", "SKILL.md"),
    claude: "the `Agent` tool call this runbook dispatches through (`subagent_type`, no working-directory field anywhere in this file) hands a member its cwd purely through the dispatch prompt — **Phase 2**'s \"You are ALREADY in worktree `<abs-path>`\" — so every write that member makes is addressed there by the absolute path alone.",
    omp: "the `task` tool's item schema — `name`/`agent`/`task`/`outputSchema`/`schemaMode` always, `effort`/`isolated` only when their own settings enable them — carries no working-directory field either; measured directly: a member dispatched through it with none of those fields, told only to report `pwd`, returned the calling session's own cwd, not the claimed worktree, the same output an un-`cwd`-set `bash` call gives from that session, so the recipe is the same dispatch-prompt absolute path, plus `bash`'s own `cwd` parameter set to it on every call and absolute paths for `write`/`edit`.",
    issue: 1362,
    why: "Worktree/claim-model cwd recipe (#1344): omp line's item-schema field list and measured-gap detail has no Claude-side counterpart clause",
  },
  {
    file: join("commands", "review-and-fix.md"),
    claude: '`Workflow({name: "fleet-ctl:review-pr", args: {pr, branch, worktree, testCmd, scratch}})` is the fleet\'s **default** review path on this harness.',
    omp: '`eval` loading `scripts/review-eval.mjs` through the Resolver (`FLEET_HARNESS=omp fleet-run --path review-eval.mjs`) and calling `runReviewOnOmp({pr, branch, worktree, testCmd, scratch})` is the fleet\'s **default** review path on this harness.',
    issue: 1362,
    why: "Review-path-default pair (#1361): omp line's Resolver invocation recipe has no Claude-side counterpart clause",
  },
  {
    file: join("skills", "run-team", "SKILL.md"),
    claude: '`Workflow({name: "fleet-ctl:review-pr", args: {pr, branch, worktree, testCmd, scratch}})`.',
    omp: '`eval` loading `scripts/review-eval.mjs` through the Resolver (`FLEET_HARNESS=omp fleet-run --path review-eval.mjs`) and calling `runReviewOnOmp({pr, branch, worktree, testCmd, scratch})`.',
    issue: 1362,
    why: "Review-path-default pair (#1361), restated in SKILL.md",
  },
  {
    file: join("workflows", "review-pr.js"),
    claude: "point the reader at `Workflow({scriptPath, resumeFromRunId})` — this file's own resumability contract, unchanged by the port.",
    omp: "review-core.js's `resumeFor` reports the same crash population and says re-run — no cached `agent()` replay exists under eval (ADR 0004/0005, #1349 gap 1).",
    issue: 1362,
    why: "review-pr.js's resumeFor cross-reference (#1361): omp line names the actual ADR/gap citation, no Claude-side counterpart",
  },
  {
    file: join("skills", "run-team", "SKILL.md"),
    claude: "a freed slot is refilled by re-entering phase 1 then phase 2 and making one more `Agent` call under a name no member has held, so the refill is a level-check you run — on the edges Phase 3 already handles, and on the heartbeat — because nothing here holds a queue that could hand the freed slot its next ticket by itself.",
    omp: "a freed slot is refilled by the staging wave's own dispatch pool, which hands a queued item to the freed worker with no completion event for you to observe — `eval`'s `workpool(agent, name, context, tools)`, opened once per wave, read for the level condition, and pushed to the number of items the tick says may be in flight.",
    issue: 1590,
    why: "Implementer-refill pair (#1590): the omp line's pool mechanism — queued item handed to a freed worker with no event — is the divergence itself, so it has no Claude-side counterpart clause to normalize against",
  },
];

function isExempt(pair) {
  return KNOWN_EQUALITY_EXCEPTIONS.some((e) => e.file === pair.file && e.claude === pair.claude && e.omp === pair.omp);
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

// The `dispatch field` entry's omp token (`` `agent( ``) is ambiguous inside
// `workflows/*.js`: `review-pr.js` names its OWN Claude-side Workflow-script
// builtin with the identical spelling (ADR 0004). `WORKFLOWS_DIR` is the one
// place that ambiguity is resolved — every other `DIALECT_TOKENS` entry
// applies everywhere.
const WORKFLOWS_DIR = "workflows" + "/";
function tokenSideApplies(entry, side, file) {
  if (entry.name === "dispatch field" && side === "omp" && typeof file === "string" && file.startsWith(WORKFLOWS_DIR)) return false;
  return true;
}

// Widens a token hit to its WHOLE enclosing backtick span before replacing
// with a placeholder — see this file's header for why (a token regex like
// `` /`hub\b/ `` only anchors the span's opening word; `` `hub send` `` and
// `` `hub cancel` `` must normalize to the SAME placeholder, not leave their
// tails behind to break equality on a difference that isn't dialect at all).
// `file`, optional: disables the `dispatch field` entry's omp side inside
// `workflows/*.js` (see DISAMBIGUATION, this file's header, and
// `tokenSideApplies` above).
export function normalizeDialect(text, file) {
  let out = text.replace(/`fleet-ctl:/g, "`");
  out = out.replace(/`[^`]*`/g, (span) => {
    for (const entry of DIALECT_TOKENS) {
      if (tokenSideApplies(entry, "claude", file) && entry.claude.test(span)) return `<${entry.name}>`;
      if (tokenSideApplies(entry, "omp", file) && entry.omp.test(span)) return `<${entry.name}>`;
    }
    return span;
  });
  return out.trim().replace(/\s+/g, " ");
}

// Recognized tokens belonging to `harness` (the OTHER harness, from a line's
// point of view) found inside `text`. A non-empty result on a line is always
// a defect: the line's own harness needs none of its own name checked here
// (equality/content pins do that), only that it carries none of the
// partner's. `file`, optional, same disambiguation as `normalizeDialect`.
export function foreignTokens(text, harness, file) {
  const side = harness === "CLAUDE" ? "claude" : "omp";
  return DIALECT_TOKENS.filter((t) => tokenSideApplies(t, side, file) && t[side].test(text)).map((t) => t.name);
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

  const claudeForeign = foreignTokens(pair.claude, "OMP", pair.file);
  const ompForeign = foreignTokens(pair.omp, "CLAUDE", pair.file);
  if (claudeForeign.length) violations.push(`${pair.file}:${pair.claudeLine}: CLAUDE line carries omp token(s): ${claudeForeign.join(", ")}`);
  if (ompForeign.length) violations.push(`${pair.file}:${pair.ompLine}: OMP line carries Claude token(s): ${ompForeign.join(", ")}`);

  if (kind === "invalid") {
    violations.push(`${pair.file}:${pair.claudeLine}-${pair.ompLine}: both lines carry a non-applicability idiom — neither states the rule`);
  } else if (kind === "same-rule") {
    const eq = normalizeDialect(pair.claude, pair.file) === normalizeDialect(pair.omp, pair.file);
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
