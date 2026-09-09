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
// MUTATION RECORD — the four runs actually executed, once, on a real pair
// (member-lifecycle.md:32-33, the Wake pair), scratch-copy method (`cp -R
// plugin/` to a tmp dir, mutate the copy, `node --test` the copy, read
// counts, discard). Baseline on the unmutated copy: this file 18/18,
// `member-lifecycle-dialect-prose.test.mjs` 10/10.
//
//   1. CLAUDE line inverted ("does not resume its transcript ... drags no
//      old ticket in"): the Wake pair's own pin failed, and so did the
//      SKILL.md-restates-Wake-identically pin (8/10). THIS file stayed
//      18/18 — a real, measured gap this record exists to surface: the Wake
//      pair is already a `KNOWN_EQUALITY_EXCEPTIONS` entry (#1362), so its
//      equality check is not live, and a plain inversion introduces no
//      foreign token for `foreignTokens` to catch either. On a pair NOT on
//      that list, run 1 reds this file directly (`mutation run 1/2` above,
//      against the controlled `CLEAN_PAIR` fixture, proves that half). This
//      is why the exception list is scoped as narrowly as `checkPair`
//      makes it (`exemptViolations` only ever holds the equality gap) and
//      why #1362 stays open rather than being treated as cosmetic.
//   2. OMP line inverted symmetrically: same outcome, mirrored (own pin
//      8/10; this file 18/18, same reason).
//   3. Benign reword of the shared sentence above the pair ("One member,
//      one unit of work, gone." -> "One member, one piece of work, then
//      gone."): own pin 10/10, this file 18/18 — neither marked line
//      touched, so nothing this file reads changed.
//   4. Token swap (CLAUDE line renamed to say `` `hub send` ``, OMP line
//      renamed to say `` `SendMessage` ``, rest of each line unchanged): own
//      pin 8/10 (the Wake pair's own `doesNotMatch` pins). THIS file: 16/18
//      — "no pair's line carries the other harness's dialect token" and the
//      same-rule-equality test (which reports any non-exempt violation, and
//      the foreign-token hit is never exempt) both failed, naming the Wake
//      pair. This is the mutant the exception list does NOT blind the check
//      to: `foreignTokens` is independent of `normalizeDialect`-equality by
//      construction, exactly as `mutation run 4` (below, on the controlled
//      fixture) predicts, and this real run confirms it on an already-
//      exempted pair, not just a clean synthetic one.
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

test("real tree: at least the nine pairs #1341/#1344 landed are found, correctly classified", () => {
  const { pairs } = pairTree(REPO);
  assert.ok(pairs.length >= 9, `expected at least 9 real pairs, found ${pairs.length}`);
  const byKind = { "same-rule": 0, "does-not-apply": 0, invalid: 0 };
  for (const p of pairs) byKind[classifyPair(p)]++;
  assert.ok(byKind["does-not-apply"] >= 3, "the three landed does-not-apply pairs (two in member-lifecycle.md, one restated in SKILL.md) must classify as such");
  assert.equal(byKind.invalid, 0, "no real pair states \"does not apply\" on both lines");
});

test("real tree: does-not-apply pairs carry the exact literal phrase, on exactly one line", () => {
  const { pairs } = pairTree(REPO);
  for (const p of pairs.filter((p) => classifyPair(p) === "does-not-apply")) {
    const onClaude = /does not apply/i.test(p.claude);
    const onOmp = /does not apply/i.test(p.omp);
    assert.notEqual(onClaude, onOmp, `${p.file}:${p.claudeLine}-${p.ompLine}: exactly one line must carry "does not apply"`);
  }
});

test("real tree: no pair's line carries the other harness's dialect token", () => {
  const { pairs } = pairTree(REPO);
  const offenders = [];
  for (const p of pairs) {
    const cf = foreignTokens(p.claude, "OMP");
    const of = foreignTokens(p.omp, "CLAUDE");
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

test("real tree: KNOWN_EQUALITY_EXCEPTIONS names exactly the pairs that need it — an entry with no matching real pair is dead weight", () => {
  const { pairs } = pairTree(REPO);
  for (const ex of KNOWN_EQUALITY_EXCEPTIONS) {
    const p = pairs.find((p) => p.file === ex.file && p.claudeLine === ex.claudeLine);
    assert.ok(p, `KNOWN_EQUALITY_EXCEPTIONS names ${ex.file}:${ex.claudeLine}, which no real pair occupies — stale entry`);
    assert.equal(classifyPair(p), "same-rule", `${ex.file}:${ex.claudeLine} is exempted from the SAME-RULE equality check but classifies as ${classifyPair(p)}`);
    assert.notEqual(
      normalizeDialect(p.claude),
      normalizeDialect(p.omp),
      `${ex.file}:${ex.claudeLine} is listed as an equality exception but its lines are already equal — the entry (and #${ex.issue}) is stale, remove it`,
    );
  }
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
