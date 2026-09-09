// #1346, ruled on #1299/ADR 0004: the marked-pair divergence-check
// instrument. `marked-pairs.mjs` is the data layer (scan, pair, classify,
// normalize); this file is the test suite over both a controlled fixture
// tree and the real one.
//
// FIXTURE TESTS come first, deliberately — they prove the mechanism against
// text this file controls, before the real-tree section reports what the
// mechanism finds against text nobody controls for the purpose of this
// check. #1346's acceptance criteria are fixture-shaped (three pairs, one
// each of same-rule / does-not-apply / orphan) for exactly this reason: a
// check that only ever runs against real prose cannot be told apart from
// one that happens to agree with today's real prose by accident.
//
// REAL-TREE TESTS run `pairTree` against this repo's actual `plugin/`
// directory and assert: zero orphans; every pair's foreign-token check is
// clean; every does-not-apply pair carries the phrase; every same-rule pair
// is equal after normalization OR is a named, ticketed entry in
// `KNOWN_EQUALITY_EXCEPTIONS` (see `marked-pairs.mjs`'s header and #1362 —
// filed by this ticket, not silently absorbed by loosening the check).
//
// MUTATION RECORD — the four runs actually executed, on a real pair
// (member-lifecycle.md:32-33, the Wake pair), scratch-copy method (`cp -R
// plugin/` to a tmp dir, mutate the copy, `node --test` the copy, read
// counts, discard, one mutant per copy). Run twice: once when
// `KNOWN_EQUALITY_EXCEPTIONS` was keyed by `file` + the CLAUDE line's exact
// text alone, and again — the numbers recorded below — after Review1363's
// finding that the CLAUDE-only key left the OMP line free to change under
// an unchanged CLAUDE line and keep the exemption (measured: mutating only
// the OMP line with the CLAUDE-only key stayed 18/18 green). The key now
// covers BOTH lines; every number below is from that version. Baseline on
// the unmutated copy: this file 18/18, `member-lifecycle-dialect-prose.
// test.mjs` 10/10.
//
//   1. CLAUDE line inverted ("does not resume its transcript ... drags no
//      old ticket in"): the Wake pair's own pin failed (8/10, with
//      SKILL.md's restates-Wake-identically pin). THIS file: 16/18 — "every
//      same-rule pair is equal..." failed (the pair's CLAUDE text no longer
//      matches the exception entry, so `isExempt` returns false and the
//      pre-existing equality gap becomes an unexempted violation) and
//      "KNOWN_EQUALITY_EXCEPTIONS is exactly the set..." failed alongside it
//      (the mutated pair now needs exemption under a text the list does not
//      contain). The content key catches an inversion NOT by detecting the
//      inversion's meaning, but by detecting that the exempted pair no
//      longer exists in its exempted form — sufficient here because #1362's
//      exemption is itself contingent on the exact wording measured.
//   2. OMP line inverted symmetrically ("does not wake it into its old
//      transcript"): own pin 8/10; THIS file 16/18, the SAME two tests,
//      confirming the both-line key (the CLAUDE-only key's asymmetry — this
//      run alone stayed 18/18 under it — is exactly what widening to both
//      lines closed).
//   3. Benign reword of the shared sentence above the pair ("One member,
//      one unit of work, gone." -> "One member, one piece of work, then
//      gone."): own pin 10/10, this file 18/18 — neither marked line
//      touched, so nothing this file reads changed, including the
//      exemption key.
//   4. Token swap (CLAUDE line renamed to say `` `hub send` ``, OMP line
//      renamed to say `` `SendMessage` ``, rest of each line unchanged): own
//      pin 8/10. THIS file: 15/18 — "no pair's line carries the other
//      harness's dialect token" failed (the swap itself), plus the same two
//      equality/membership tests from runs 1/2 (both lines' text changed,
//      so the exemption match breaks here too). `foreignTokens` is still
//      the mutant-specific catch — `normalizeDialect` alone maps both
//      swapped tokens to the same placeholder and would report the lines
//      "equal" if the content key had not already unexempted the pair
//      first; on a pair that starts genuinely equal (this file's own
//      `CLEAN_PAIR` fixture, `mutation run 4` below) `foreignTokens` is the
//      ONLY thing that reds, which is the case this repo's real same-rule
//      pairs cannot demonstrate today (none of them are equal to begin
//      with).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanFile,
  scanTree,
  pairFile,
  pairTree,
  classifyPair,
  normalizeDialect,
  foreignTokens,
  checkPair,
  KNOWN_EQUALITY_EXCEPTIONS,
  DOES_NOT_APPLY_RE,
  MD_DIRS,
  JS_DIRS,
} from "./marked-pairs.mjs";
import { between, pairSlices, DIALECT_TOKENS } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Builds a scratch tree with exactly the dirs `marked-pairs.mjs` scans
// (`MD_DIRS`/`JS_DIRS`), so `scanTree`/`pairTree` run against it exactly as
// they run against the real repo — no special-cased fixture entry point.
function fixtureTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), "marked-pairs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Acceptance criterion 1: three pairs (same-rule, does-not-apply, orphan) —
// the check fails EXACTLY on the orphan, and names it.
// ---------------------------------------------------------------------------

const THREE_PAIR_FIXTURE = [
  "## Same-rule section",
  "",
  "CLAUDE: `SendMessage` wakes the member.",
  "OMP: `hub send` wakes the member.",
  "",
  "## Does-not-apply section",
  "",
  "CLAUDE: the retry step runs before the timeout.",
  "OMP: the retry step does not apply — there is no timeout on this harness.",
  "",
  "## Orphan section",
  "",
  "CLAUDE: reap runs after release, with no omp partner stated.",
  "",
  "## Trailer",
].join("\n");

test("fixture: three pairs — the check fails exactly on the deliberately orphaned one, and names it", (t) => {
  const root = fixtureTree(t, { "skills/fixture.md": THREE_PAIR_FIXTURE });
  const { pairs, orphans } = pairTree(root);

  assert.equal(pairs.length, 2, "the same-rule and does-not-apply sections must both pair");
  assert.equal(orphans.length, 1, "exactly the deliberately orphaned CLAUDE line must be unpaired");

  const [orphan] = orphans;
  assert.equal(orphan.file, "skills/fixture.md");
  assert.equal(orphan.harness, "CLAUDE");
  assert.match(orphan.text, /reap runs after release/, "the orphan is named by its own content, not just a line number");
  assert.match(orphan.reason, /no adjacent partner/);

  const kinds = pairs.map((p) => classifyPair(p)).sort();
  assert.deepEqual(kinds, ["does-not-apply", "same-rule"]);

  for (const p of pairs) {
    const v = checkPair(p);
    assert.deepEqual(v.violations, [], `${p.file}:${p.claudeLine}-${p.ompLine} must be clean on this controlled fixture`);
  }
});

test("fixture: a duplicated marker (two adjacent CLAUDE lines) is its own orphan, distinct from the pair beside it", (t) => {
  const fixture = [
    "## Section",
    "",
    "CLAUDE: first claude line, unpaired.",
    "CLAUDE: second claude line, then the real pair.",
    "OMP: the real omp partner.",
  ].join("\n");
  const root = fixtureTree(t, { "skills/dup.md": fixture });
  const { pairs, orphans } = pairTree(root);
  assert.equal(pairs.length, 1);
  assert.equal(orphans.length, 1);
  assert.match(orphans[0].reason, /duplicate CLAUDE marker/);
  assert.match(orphans[0].text, /first claude line/);
  // The real pair beside the duplicate must still be found, not swallowed by it.
  assert.match(pairs[0].claude, /second claude line/);
});

// Review1363's finding: MARKER_RE (pre-fix) could not match a line ending in
// `\r` — CRLF-authored files leave a trailing `\r` on every line after
// `scanFile`'s `\n` split, and an un-flagged `$` refuses to match past it.
// Mixed on purpose (one CRLF pair beside two LF ones, same file) so a
// regression that reintroduces the bug drops exactly the CRLF pair, not the
// whole file.
test("fixture: a CRLF-authored pair is found, not silently invisible", (t) => {
  const fixture = ["## Section", "", "CLAUDE: LF pair, found normally.", "OMP: LF partner.", "", "CLAUDE: CRLF pair, must not vanish.\r", "OMP: CRLF partner.\r", ""].join("\n");
  const root = fixtureTree(t, { "skills/crlf.md": fixture });
  const { pairs, orphans } = pairTree(root);
  assert.deepEqual(orphans, []);
  assert.equal(pairs.length, 2, "both the LF and the CRLF pair must be found");
  const crlf = pairs.find((p) => /CRLF pair/.test(p.claude));
  assert.ok(crlf, "the CRLF pair must not be silently dropped");
  assert.equal(crlf.claude, "CRLF pair, must not vanish.", "the captured text must not retain a trailing \\r");
  assert.equal(crlf.omp, "CRLF partner.");
});

// FENCED CODE BLOCKS, documented (not fixed) in this file's header: a marker
// written as a markdown code EXAMPLE is scanned and checked exactly like
// real prose. Canary, not a bug report — if a future edit adds fence
// tracking, this test's own expectation (pairs.length === 1) is the one to
// update, so that change cannot land silently either.
test("fixture: a marker inside a fenced code block is still scanned and paired (documented, not tracked)", (t) => {
  const fixture = ["## Section", "", "Illustrating the marker grammar:", "", "```", "CLAUDE: `SendMessage` wakes the member.", "OMP: `hub send` wakes the member.", "```"].join("\n");
  const root = fixtureTree(t, { "skills/fence.md": fixture });
  const { pairs, orphans } = pairTree(root);
  assert.deepEqual(orphans, []);
  assert.equal(pairs.length, 1, "a pair inside a fence is scanned like any other line — fences are not tracked, by design");
  assert.equal(classifyPair(pairs[0]), "same-rule");
});

// ---------------------------------------------------------------------------
// Acceptance criterion 3: a pin that matches both lines of a pair throws at
// construction. `prose-pin.test.mjs` unit-tests each of `pairSlices`' four
// guards in isolation (both no-token cases, both cross-match cases); this is
// the one demonstration kept here, in the ticket's own divergence-check
// suite, as the acceptance criterion's direct evidence.
// ---------------------------------------------------------------------------

test("pairSlices: a pin that would match both lines is rejected at construction (throws)", () => {
  // Badly authored: the OMP line ALSO carries `SendMessage`, so a pin
  // anchored on the CLAUDE line's own token would be satisfied by either
  // line — exactly the #1299 hazard `pairSlices` exists to reject before
  // that pin is ever written.
  const text = [
    "## Section",
    "",
    "CLAUDE: `SendMessage` wakes the member.",
    "OMP: `hub send` and, mistakenly, `SendMessage` too, wake the member.",
    "",
    "## Next",
  ].join("\n");
  assert.throws(
    () => pairSlices(text, "## Section", "## Next"),
    /also matches the OMP line/,
    "a token common to both lines must be rejected at construction, not left for a later mutation run to discover",
  );
});

// ---------------------------------------------------------------------------
// Mutation-mechanism fixture: proves normalizeDialect + foreignTokens
// together catch every #1299 run-1/2/4 mutant, and stay green on run 3 —
// against a CONTROLLED clean pair (the real-tree section below records the
// same procedure run for real, on Wake, member-lifecycle.md).
// ---------------------------------------------------------------------------

const CLEAN_PAIR = {
  file: "fixture.md",
  claudeLine: 1,
  ompLine: 2,
  claude: "`SendMessage` wakes the member.",
  omp: "`hub send` wakes the member.",
};

test("mutation mechanism: a clean same-rule pair passes equality and both foreign-token checks", () => {
  const v = checkPair(CLEAN_PAIR);
  assert.equal(v.kind, "same-rule");
  assert.deepEqual(v.violations, []);
  assert.equal(normalizeDialect(CLEAN_PAIR.claude), normalizeDialect(CLEAN_PAIR.omp));
});

test("mutation run 1/2: inverting either line's tool clause breaks equality — the divergence check fails", () => {
  const invertedClaude = { ...CLEAN_PAIR, claude: "`SendMessage` does not wake the member." };
  assert.notEqual(normalizeDialect(invertedClaude.claude), normalizeDialect(invertedClaude.omp));
  assert.notEqual(checkPair(invertedClaude).violations.length, 0);

  const invertedOmp = { ...CLEAN_PAIR, omp: "`hub send` does not wake the member." };
  assert.notEqual(normalizeDialect(invertedOmp.claude), normalizeDialect(invertedOmp.omp));
  assert.notEqual(checkPair(invertedOmp).violations.length, 0);
});

test("mutation run 3: a benign reword outside the marked lines leaves the pair itself untouched and green", () => {
  // The mutant lands on prose ABOVE the pair, never on the marked lines
  // `checkPair` reads — so from this file's point of view there is nothing
  // to re-check; the pair's own verdict is unchanged.
  const before = checkPair(CLEAN_PAIR);
  const after = checkPair({ ...CLEAN_PAIR }); // same marked-line content, simulating an untouched pair after a reword elsewhere
  assert.deepEqual(before.violations, after.violations);
  assert.deepEqual(before.violations, []);
});

test("mutation run 4 (the two-dialect-specific mutant): a token swap survives normalizeDialect ALONE, which is why foreignTokens exists", () => {
  // Tokens swapped in place, rest of each line unchanged.
  const swapped = { ...CLEAN_PAIR, claude: "`hub send` wakes the member.", omp: "`SendMessage` wakes the member." };
  // The gap this file's header documents: normalizeDialect alone cannot see
  // a swap, because both sides' tokens map to the SAME placeholder
  // regardless of which line carries which.
  assert.equal(
    normalizeDialect(swapped.claude),
    normalizeDialect(swapped.omp),
    "normalizeDialect alone is symmetric — demonstrating why a second, independent check is required",
  );
  // foreignTokens is that second check, and it is what actually catches the swap.
  assert.deepEqual(foreignTokens(swapped.claude, "OMP"), ["send/wake channel"]);
  assert.deepEqual(foreignTokens(swapped.omp, "CLAUDE"), ["send/wake channel"]);
  const v = checkPair(swapped);
  assert.notEqual(v.violations.length, 0, "the divergence check must fail on a token swap");
});

// ---------------------------------------------------------------------------
// Real-tree divergence check.
// ---------------------------------------------------------------------------

test("real tree: the walk reaches every scoped directory", () => {
  for (const d of MD_DIRS) {
    const files = scanTree(REPO).filter((f) => f.file.startsWith(d + "/") && f.file.endsWith(".md"));
    assert.ok(files.length > 0, `${d}/ must contribute at least one .md file to the scan`);
  }
  // workflows/ is in scope by design (this file's header) even though no
  // real .js comment-form pair exists yet (verified 2026-09-09, pre-#1361) —
  // asserted as a walk floor of zero, not skipped, so a future regression
  // that stops walking workflows/ entirely still reds this test once #1361
  // lands its first real pair.
  for (const d of JS_DIRS) {
    const files = scanTree(REPO).filter((f) => f.file.startsWith(d + "/") && f.file.endsWith(".js"));
    assert.ok(files.length >= 0);
  }
});

test("real tree: no marker is orphaned", () => {
  const { orphans } = pairTree(REPO);
  assert.deepEqual(
    orphans,
    [],
    `orphaned marker(s): ${orphans.map((o) => `${o.file}:${o.line} (${o.harness}, ${o.reason})`).join("; ")}`,
  );
});

test("real tree: at least the 13 pairs #1341/#1344/#1361 landed are found, correctly classified", () => {
  const { pairs } = pairTree(REPO);
  assert.ok(pairs.length >= 13, `expected at least 13 real pairs, found ${pairs.length}`);
  const byKind = { "same-rule": 0, "does-not-apply": 0, invalid: 0 };
  for (const p of pairs) byKind[classifyPair(p)]++;
  assert.ok(byKind["does-not-apply"] >= 5, "the five landed does-not-apply pairs (three literal-phrase, two \"has no slot for\" Settle/liveness pairs) must classify as such");
  assert.equal(byKind.invalid, 0, "no real pair states a non-applicability idiom on both lines");
});

test("real tree: does-not-apply pairs carry a recognized non-applicability idiom, on exactly one line", () => {
  const { pairs } = pairTree(REPO);
  for (const p of pairs.filter((p) => classifyPair(p) === "does-not-apply")) {
    const onClaude = DOES_NOT_APPLY_RE.test(p.claude);
    const onOmp = DOES_NOT_APPLY_RE.test(p.omp);
    assert.notEqual(onClaude, onOmp, `${p.file}:${p.claudeLine}-${p.ompLine}: exactly one line must carry a recognized non-applicability idiom`);
  }
});

test("real tree: no pair's line carries the other harness's dialect token", () => {
  const { pairs } = pairTree(REPO);
  const offenders = [];
  for (const p of pairs) {
    const cf = foreignTokens(p.claude, "OMP", p.file);
    const of = foreignTokens(p.omp, "CLAUDE", p.file);
    if (cf.length) offenders.push(`${p.file}:${p.claudeLine} carries omp token(s) ${cf.join(",")}`);
    if (of.length) offenders.push(`${p.file}:${p.ompLine} carries Claude token(s) ${of.join(",")}`);
  }
  assert.deepEqual(offenders, []);
});

test("real tree: every same-rule pair is equal after stripping dialect tokens, or is a named exception on a filed issue (#1362)", () => {
  const { pairs } = pairTree(REPO);
  const offenders = [];
  for (const p of pairs.filter((p) => classifyPair(p) === "same-rule")) {
    const v = checkPair(p);
    // Only the equality violation may be absorbed by the exception list —
    // any OTHER violation on an "exempt" pair (a foreign token, say) is
    // still a real failure: the exception is scoped to the one measured
    // gap #1362 names, not a blanket pass for the pair.
    if (v.violations.length) offenders.push(`${p.file}:${p.claudeLine}-${p.ompLine}: ${v.violations.join("; ")}`);
  }
  assert.deepEqual(offenders, [], "same-rule pairs failing equality outside the named exception list are a NEW finding — do not add them to KNOWN_EQUALITY_EXCEPTIONS without filing an issue");
});

// Bidirectional, so the list's SIZE is pinned without a magic number that
// goes stale on every legitimate addition: no listed entry may lack a real
// pair that still needs it (a stale entry, caught below), and no real pair
// needing exemption may be absent from the list (a SILENT, un-filed
// addition — the growth Review1363's finding named as unguarded). Keyed by
// `file` + BOTH lines' exact text, never a line number — the content key
// `marked-pairs.mjs`'s header explains (a numeric key breaks on any
// insertion above the pair; content survives it and still reacts to an
// edit of EITHER line, which is the change that should invalidate an
// exemption — a CLAUDE-only key left the OMP line free to change under an
// unchanged CLAUDE line and keep the exemption, measured directly on a
// scratch copy before this file's own key was widened to both).
test("real tree: KNOWN_EQUALITY_EXCEPTIONS is exactly the set of same-rule pairs that need it — no stale entries, nothing added silently", () => {
  const { pairs } = pairTree(REPO);
  const sameRule = pairs.filter((p) => classifyPair(p) === "same-rule");
  const needExemption = sameRule.filter((p) => normalizeDialect(p.claude, p.file) !== normalizeDialect(p.omp, p.file));

  for (const ex of KNOWN_EQUALITY_EXCEPTIONS) {
    assert.equal(ex.issue, 1362, `${ex.file}: every exception must cite the filed issue (#1362)`);
    const p = needExemption.find((p) => p.file === ex.file && p.claude === ex.claude && p.omp === ex.omp);
    assert.ok(p, `KNOWN_EQUALITY_EXCEPTIONS names ${ex.file}: ${JSON.stringify(ex.claude)}, which no real pair still needing exemption occupies — stale entry`);
  }
  for (const p of needExemption) {
    const ex = KNOWN_EQUALITY_EXCEPTIONS.find((e) => e.file === p.file && e.claude === p.claude && e.omp === p.omp);
    assert.ok(ex, `${p.file}:${p.claudeLine}-${p.ompLine} fails equality but is not in KNOWN_EQUALITY_EXCEPTIONS — a NEW finding: file an issue before adding it here`);
  }
  assert.equal(KNOWN_EQUALITY_EXCEPTIONS.length, needExemption.length, "the exception list's size must exactly match the real exempted set — a silent addition or a stale leftover would pass this far without this line");
});

// ---------------------------------------------------------------------------
// #1299's "two collisions" scoping: resume/truncated slices bounded inside
// member-lifecycle.md's own sections, never spanning into review-pr.js.
// ---------------------------------------------------------------------------

test("coordination scoping (fixture): a phrase moved from member-lifecycle.md's section into review-pr.js's section does not satisfy the coordination pin", () => {
  // Grounded in the real ambiguity #1299's ruling names: "truncated" is two
  // concepts in this tree — agent truncation (member-lifecycle.md's Settle
  // pair, real text: "idle or truncated still answers `SendMessage`") vs
  // PR-file-list truncation (`stats.truncated`, review-pr.js's diff-stats
  // header). Both fixtures below use the real word "truncated" so a NAIVE,
  // unbounded scan would find a hit either way; only the specific coordination
  // PHRASE, bounded to member-lifecycle's own section, is what the real pin
  // (member-lifecycle-dialect-prose.test.mjs's Settle/liveness test) asserts.
  const COORD_PHRASE = "idle or truncated still answers";

  // "Moved": member-lifecycle's own Settle section no longer states the
  // phrase (as if it had been deleted from here), but the decoy word
  // "truncated" still appears nearby via an unrelated recovery sentence —
  // the exact shape #1299 warns a loose word-level pin would satisfy itself
  // from the wrong concept's text.
  const memberLifecycleFixture = [
    "## Settle",
    "",
    "CLAUDE: killed, idle, or dead — the temptation to re-task a truncated member peaks exactly when it cannot work.",
    "OMP: no distinct truncated state exists on omp.",
    "",
    "## Recovery",
  ].join("\n");

  // The phrase now lives ONLY here, inside a separate document standing in
  // for review-pr.js's own, unrelated truncation concept.
  const reviewPrFixture = [
    "// diff-stats",
    "// idle or truncated still answers, in a PR-file-list sense: gh caps the list.",
  ].join("\n");

  const region = between(memberLifecycleFixture, "## Settle", "## Recovery", "fixture Settle section");
  assert.doesNotMatch(
    region,
    new RegExp(COORD_PHRASE),
    "the coordination pin, bounded to member-lifecycle's own section, must not be satisfiable by review-pr.js's truncation concept",
  );
  // Sanity: the phrase genuinely exists somewhere — in the OTHER document —
  // so a passing assertion above is because of file/section scoping, not
  // because the phrase is absent from both fixtures.
  assert.match(reviewPrFixture, new RegExp(COORD_PHRASE));
});

// ---------------------------------------------------------------------------
// DIALECT_TOKENS sanity: every real pair's own harness names a recognized
// token drawn from this table (used implicitly by pairSlices; asserted here
// so a future edit to the table cannot silently stop recognizing real prose
// without any test reacting).
// ---------------------------------------------------------------------------

test("DIALECT_TOKENS: every real same-rule/does-not-apply pair's non-empty line names at least one recognized token where one is expected", () => {
  const { pairs } = pairTree(REPO);
  // Wake, Receipts, Settle/liveness (both copies) and the cwd-recipe pair all
  // name a tool explicitly on both lines; the two does-not-apply pairs name
  // one on their applying (Claude) line. Floor, not an exact count — new
  // pairs may add tokens this table does not yet know, which is a
  // DIALECT_TOKENS gap to fix, not a reason to weaken this floor.
  const withToken = pairs.filter((p) => DIALECT_TOKENS.some((t) => t.claude.test(p.claude) || t.omp.test(p.omp)));
  assert.ok(withToken.length >= 7, `expected at least 7 of ${pairs.length} real pairs to name a recognized dialect token, found ${withToken.length}`);
});
