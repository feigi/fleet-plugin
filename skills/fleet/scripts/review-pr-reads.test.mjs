import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between } from "./prose-pin.mjs";
import { lift } from "./lift.mjs";

// `workflows/review-pr.js` runs a top-level `await pipeline(...)`, so importing
// it executes the workflow. Both functions under test are lifted out of the
// SOURCE TEXT instead — the same technique as `select-dimensions.test.mjs`'s
// `liftFromSource` and `review-pr-testcmd.test.mjs`'s lift of `resolveTestCmd`, and for the same
// reason: extraction to a module would need `import` to resolve inside the
// Workflow sandbox, and it does not. That was the documented claim until #538
// executed it — `import()` refused for any specifier and `require` undefined,
// with the verdict and its controls recorded beside `snapshotMissing` in
// review-pr.js. Nothing in `workflows/` imports, and a failed import bricks the
// fleet's DEFAULT review path, so the lift is a constraint, not a preference.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// Every pin below runs against CODE, not SOURCE: a declaration or a paragraph a
// reader's eye skips must not satisfy an assertion. Stripping once closes the
// class for every assertion in this file, including ones added later — see
// strip-comments.mjs for the two escapes measured green without it, and for why
// the stripper is shared rather than copied into each test file.
const CODE = stripComments(SOURCE);

const usableDiff = lift(CODE, "usableDiff", "snap");

// #1129: `usableDiff` no longer returns the reported `diffPath`, it REBUILDS
// the path from the run root the caller already checked — the redirect that
// wrote the file is `> "$RUN"/pr.diff` inside the snapshot block, so the path is
// the caller's to derive. What the reported field still decides is whether the
// capture happened at all, which is why every fixture below varies `diffPath`
// while the accepted RESULT is always derived from `runRoot`.
const ROOT = "/s/pr7/run-ab12cd34";

// A diff that is empty, or that describes a commit other than the snapshot's,
// is worse than no diff: the specialist reads it as authoritative.
test("usableDiff rejects a diff that would lie about the snapshot", () => {
  assert.equal(usableDiff({ head: "aaa" }), null, "no diffPath");
  assert.equal(
    usableDiff({ head: "aaa", diffLines: 40 }),
    null,
    "diffPath absent but diffLines truthy — isolates the diffPath guard from the diffLines guard",
  );
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 0 }),
    null,
    "0-byte diff — `gh pr diff` exits 1 and still leaves the file",
  );
  // The one guard where ABSENT and 0 mean the same thing, against the rule the
  // prHead clause follows. Deliberate: the count is not a cross-check, it is the
  // only thing that rules out that 0-byte file, so an unreported count leaves
  // "usable" a guess. Pinned because it reads like the inversion bug.
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff" }),
    null,
    "diffLines absent — no count means the 0-byte case cannot be ruled out",
  );
  assert.equal(
    usableDiff({ head: "aaa", diffPath: "/s/pr.diff", diffLines: 40, prHead: "bbb" }),
    null,
    "prHead present and unequal — the diff describes another commit",
  );
});

// The inversion this guard is most likely to get wrong. `gh pr view` can fail
// while `gh pr diff` succeeded; dropping a good diff over a MISSING cross-check
// lets absent input narrow coverage — the `=== true` guards in
// `selectDimensions`, inverted.
test("usableDiff accepts when prHead is absent or matching", () => {
  assert.equal(
    usableDiff({ runRoot: ROOT, head: "aaa", diffPath: "/s/pr.diff", diffLines: 40 }),
    `${ROOT}/pr.diff`,
    "missing prHead must not suppress an otherwise good diff",
  );
  assert.equal(
    usableDiff({ runRoot: ROOT, head: "aaa", diffPath: "/s/pr.diff", diffLines: 40, prHead: "aaa" }),
    `${ROOT}/pr.diff`,
  );
  // `prHead` is 40 chars from `gh`; `head` is whatever the snapshot agent
  // relayed for "the HEAD sha", which an agent may abbreviate. Under a raw
  // `!==` these two matching shas compare unequal and the good diff is dropped.
  // Both directions, because either side can be the short one.
  const full = "a".repeat(40);
  assert.equal(
    usableDiff({ runRoot: ROOT, head: full.slice(0, 7), diffPath: "/s/pr.diff", diffLines: 40, prHead: full }),
    `${ROOT}/pr.diff`,
    "abbreviated head against the full prHead is the same commit, not a divergence",
  );
  assert.equal(
    usableDiff({ runRoot: ROOT, head: full, diffPath: "/s/pr.diff", diffLines: 40, prHead: full.slice(0, 7) }),
    `${ROOT}/pr.diff`,
    "and the same the other way round",
  );
  // The prefix tolerance must not swallow the case it exists beside: a genuinely
  // different sha still reds, at short length too.
  assert.equal(
    usableDiff({ head: "abc1234", diffPath: "/s/pr.diff", diffLines: 40, prHead: "abd" + "9".repeat(37) }),
    null,
    "a different sha stays disqualifying however short the compare",
  );
});

const readRules = lift(CODE, "readRules", "diffPath, stats, snap");

const PATHS = {
  paths: [
    { path: "workflows/review-pr.js", kind: "src", loc: 115 },
    { path: "docs/specs/a.md", kind: "docs", loc: 393 },
  ],
};

// Emitting both the diff pointer and the file list doubles the block on exactly
// the PRs where prompt size matters most. The branches are exclusive.
test("readRules names the diff and does not also list files", () => {
  const out = readRules("/s/pr.diff", PATHS);
  assert.match(out, /\/s\/pr\.diff/);
  assert.doesNotMatch(out, /touched exactly these files/);
  // The IMPERATIVE, not just the path. Reducing this branch to `The PR's whole
  // diff is at ${diffPath}.` left the suite green — and a path with no order to
  // read it first is pre-fix behaviour plus tokens, which is the entire defect
  // this branch exists to fix. `\s+` per the file's reflow convention.
  assert.match(
    out,
    /Read\s+it\s+FIRST,\s+bounded/,
    "the diff is named but not ordered read first — a specialist keeps reading whole files",
  );
});

// The unit is stated INLINE, per file. A bare `(115)` under a header is read as
// the file's length — "small, take it whole" on a 900-line file — which is the
// unbounded read the block exists to stop.
test("readRules falls back to the changed-file list with each file's loc", () => {
  const out = readRules(null, PATHS);
  assert.match(out, /No diff file was captured/);
  assert.match(out, /workflows\/review-pr\.js \(115 changed\)/);
  assert.match(out, /docs\/specs\/a\.md \(393 changed\)/);
  // The POSITIVE companion the four `doesNotMatch(/touched exactly these files/)`
  // assertions in this file need. Without it, renaming the phrase makes all four
  // pass forever against a branch 2 that no longer says anything of the kind —
  // a `doesNotMatch` over an unverified baseline passes trivially.
  assert.match(
    out,
    /touched exactly these files and no others/,
    "branch 2 no longer emits the closure phrase the negative assertions are written against",
  );
});

// `stats` is null whenever diff-stats.mjs errored or its blob was unparseable
// (where the caller parses `snap.diffStats`). Saying so beats emitting an empty
// list, which reads as "the PR touched no files".
test("readRules says so when it has neither a diff nor a file list", () => {
  const out = readRules(null, null);
  assert.match(out, /No diff file and no file list were captured/);
  assert.doesNotMatch(out, /touched exactly these files/);
  // This branch is ONE failure away, not two: diff-stats.mjs shells out to
  // `gh pr view <pr> --json files`, so a single broken `gh` takes the diff and
  // the file list together. It is also the branch a specialist cannot fall back
  // on anything else from — its "review request" is a dimension prompt naming no
  // file. So it has to name a discovery move. The wording it replaces
  // ("do not survey the snapshot") forbade the only one left.
  // `\s+` spans every word gap, not just the one where the source happens to
  // wrap today — the same reflow-tolerance convention the FIX-3 pins below
  // use. An anchor tied to one wrap point reds on a routine rewrap with a
  // message claiming the discovery move is missing, which it is not.
  assert.match(out, /Locate\s+the\s+files\s+your\s+dimension\s+covers/);
  assert.doesNotMatch(out, /do not survey/i);
  // The blacklist above plus the sentence pin are both evadable together:
  // rewriting this branch to "ONLY from the names your review request already
  // gives you. Never explore the snapshot" passes both — and that is verbatim
  // the regression 830bddb exists to prevent, since this branch's review request
  // names no file. Pin the AFFIRMATIVE moves instead: a synonym walks around a
  // blacklist, but it cannot supply a command that does the discovery.
  assert.match(out, /'grep -rn'/, "the discovery move is not given as a runnable command");
  assert.match(out, /'ls -R'/, "the discovery move is not given as a runnable command");
});

// A `stats` object whose `paths` is empty must NOT fall into branch 2 — that
// would print the header with nothing under it. `.length` is the guard.
test("readRules treats an empty paths array as no file list", () => {
  const out = readRules(null, { paths: [] });
  assert.match(out, /No diff file and no file list were captured/);
  assert.doesNotMatch(out, /touched exactly these files/);
});

// A `stats` object that is truthy but carries no `paths` key at all (distinct
// from an empty array) must hit the same fallback. `stats.paths` is its own
// conjunct in the guard, separate from `.length`, and nothing above isolates
// it: every other test's `stats` either has a real `paths` array or is `null`
// outright, so a middle-conjunct deletion (`stats && stats.paths.length`,
// dropping `stats.paths &&`) reads `undefined.length` — a real production
// crash if diff-stats.mjs ever returns a blob without `paths` — and every
// existing test still passes around it.
test("readRules treats a stats object with no paths key as no file list", () => {
  const out = readRules(null, {});
  assert.match(out, /No diff file and no file list were captured/);
  assert.doesNotMatch(out, /touched exactly these files/);
});

// `gh pr view --json files` pages at 100 and exits 0 — measured 100 listed
// against `changedFiles` 124. Branch 2 is the first consumer to put that list in
// front of an agent, and it did so under a closure clause. The files that fell
// off the end vanish undetectably: `stats.files` is short too, so nothing in the
// blob contradicts the sentence.
test("readRules does not claim closure over a list gh truncated", () => {
  const out = readRules(null, { ...PATHS, truncated: 124 });
  assert.doesNotMatch(
    out,
    /touched exactly these files and no others/,
    "a capped file list is still presented as the complete set of changed files",
  );
  assert.match(out, /at\s+least\s+these\s+files/);
  assert.match(out, /capped\s+the\s+list\s+at\s+2\s+of\s+124/, "the cap is not quantified, so it cannot be acted on");
  // Still a usable list — the fix is to stop overclaiming, not to withhold.
  assert.match(out, /workflows\/review-pr\.js \(115 changed\)/);
});

// `gh pr diff > pr.diff` is a shell REDIRECT: the file exists in every run, in
// the same ${scratch} tree the specialist is pointed at for its own work. On
// head skew it is non-empty and describes another commit, and "No diff file was
// captured" is then false in the one way that matters — the specialist can find
// the file and has been given no reason not to trust it.
test("readRules names a rejected diff rather than denying a file that exists", () => {
  const out = readRules(null, PATHS, { diffPath: "/s/pr.diff", diffLines: 500, prHead: "bbb", head: "aaa" });
  assert.doesNotMatch(out, /No diff file was captured/, "the diff file exists — the redirect always creates it");
  assert.match(out, /REJECTED/);
  assert.match(out, /\/s\/pr\.diff/, "the rejected file is not named, so the specialist cannot know which one to skip");
  assert.match(out, /Do not read it/);
  assert.match(out, /describes\s+commit\s+bbb/, "the rejection reason is not carried, only the rejection");
  // And the file list inherits the defect the diff was rejected FOR: it comes
  // from `gh pr view <pr> --json files`, which describes that same rejected
  // commit. Dropping the diff for the wrong tree and then serving that tree's
  // file list stamped "and no others" is the same error with the evidence gone.
  assert.doesNotMatch(
    out,
    /touched exactly these files and no others/,
    "the file list is from the rejected commit and is still stamped as closed over this snapshot",
  );
  assert.match(out, /NOT\s+this\s+snapshot's\s+commit/);
});

// The empty-file case is the OTHER rejection, and it must not borrow the head-
// skew wording — `gh pr diff 999999` exits 1 leaving a 0-byte file, with no
// commit to name. Isolates `skew` from `rejected`.
test("readRules distinguishes an empty rejected diff from a skewed one", () => {
  const out = readRules(null, PATHS, { diffPath: "/s/pr.diff", head: "aaa" });
  assert.match(out, /REJECTED — it is empty/);
  assert.doesNotMatch(out, /describes commit/);
  // No skew, complete list — closure is TRUE here and must still be claimed.
  assert.match(out, /touched exactly these files and no others/);
});

// A run with no diffPath at all is not a rejection: nothing was captured, and
// saying "a diff was captured and rejected" would be a fresh false claim.
test("readRules reports no capture when the snapshot agent reported no diffPath", () => {
  const out = readRules(null, PATHS, { head: "aaa" });
  assert.match(out, /No diff file was captured/);
  assert.doesNotMatch(out, /REJECTED/);
});

// The rule is the whole point of the block; it must survive every branch, not
// just the happy one. Assert the imperative and the counting clause, not a word
// that also appears in the surrounding rationale.
test("every branch carries the bounding rule", () => {
  for (const out of [readRules("/s/pr.diff", PATHS), readRules(null, PATHS), readRules(null, null)]) {
    assert.match(out, /BOUND EVERY READ/);
    assert.match(out, /'wc -l' says it is small/);
  }
});

// Bounded at both ends in prose-pin.mjs's between() — an unbounded end runs to
// EOF where the specialist and refuter prompts satisfy it, the defect
// `review-pr-testcmd.test.mjs`'s "the specialist prompt hands the command over
// verbatim and rules 'tests 0' a failure" records.
const slice = (from, to) => between(CODE, from, to, "review-pr.js");

// The snapshot schema's `additionalProperties: false` REJECTS an undeclared
// field, so a prompt that asks for these three while the schema omits them
// silently yields nothing. Both halves have to be pinned or the feature
// disconnects in one token.
test("the snapshot agent asks for the diff facts AND declares them in its schema", () => {
  const snapshot = slice("const snap = await agent(", "if (!snap");
  // Pinned on `"$RUN"` since #1129: the capture is a shell redirect into a
  // directory the snapshot block's own `mkdir -p` created, and both artefacts
  // hang off the same per-run root, which is what keeps `pr.diff` a SIBLING of
  // the snapshot tree (the relationship the read-rules qualifier below depends
  // on) while stopping two reviews in one session from overwriting each other's.
  assert.match(snapshot, /gh pr diff \$\{pr\} > "?\$RUN"?\/pr\.diff/, "no diff capture");
  // `/headRefOid/` alone also matches the prose ("Report `prHead` = the
  // headRefOid") in the same prompt, so deleting this command left the suite
  // green — pin the command line itself, not a word it shares with prose.
  assert.match(
    snapshot,
    /gh pr view \$\{pr\} --json headRefOid -q \.headRefOid/,
    "no PR head to cross-check against the snapshot's",
  );
  assert.match(snapshot, /wc -l < "?\$RUN"?\/pr\.diff/, "no line count — a 0-byte diff would pass as usable");
  // Scoped to the `properties` object, not the whole schema. Declaring a field
  // ANYWHERE else — beside `required`, in the options bag — leaves it undeclared
  // as far as `additionalProperties: false` is concerned, and a slice covering
  // the whole schema passes on it. Measured escape; `required` sits above
  // `properties` in the source, so this end-anchor excludes it. (Dead text is
  // already handled globally by CODE.)
  const props = between(snapshot, "properties: {", "\n      },", "the snapshot schema");
  for (const field of ["diffPath", "diffLines", "prHead"]) {
    assert.match(
      props,
      new RegExp(`^\\s*${field}:\\s*\\{\\s*type:`, "m"),
      `${field} is not declared in the schema's properties — additionalProperties:false drops it`,
    );
  }
  // Declared beside them, but not one of them: `pathVerified` belongs to
  // `required`, not to the gh-failure set, so it is pinned on its own rather
  // than folded into the loop above — whose comment, and the one below, both
  // read "these three". Only its `required` membership was pinned when it was
  // added (#140); `additionalProperties: false` is what makes the DECLARATION
  // mandatory too, for every field this schema carries.
  assert.match(
    props,
    /^\s*pathVerified:\s*\{\s*type:/m,
    "pathVerified is not declared in the schema's properties — additionalProperties:false drops it",
  );
  // The review must survive a gh failure. These three stay out of `required`.
  // `pathVerified` joins path+head instead (#140) — a caller check on whether
  // the snapshot exists, not a `gh` fact that can legitimately be absent.
  assert.match(
    snapshot,
    /required:\s*\["runRoot",\s*"path",\s*"head",\s*"pathVerified"\]/,
    "required must stay path+head+pathVerified only",
  );
  // Commands pinned, schema pinned — and the INSTRUCTION between them was not.
  // Measured: deleting this paragraph outright left this file at 12 pass, 0
  // fail. The commands still run, the schema still accepts the fields, and
  // nothing tells the agent to report any of them, so all three come back
  // omitted, `usableDiff` returns null on every run forever, and the feature
  // degrades to branch 2 under a green suite. `\s+` spans the line wraps so a
  // reflow of the same sentences stays green; the words are what is pinned.
  // These names live inside a template literal, so each backtick is a
  // BACKSLASH-backtick in the source text — `\\?` matches it either way.
  const B = "\\\\?`";
  for (const [re, missing] of [
    [
      // The measured escape for this one was re-inserting the paragraph verbatim
      // inside a `/* */` block — which starts its line with `/*`, not `//`, so a
      // `//`-only anchor would have stayed green. Handled once by CODE now,
      // rather than by an anchor each future assertion has to remember.
      // The run root, not `scratch`: #1129 moved every artefact of a run onto a
      // per-run root, and a pin left on the bare root would go green again on
      // exactly the regression it exists to stop — the diff capture sliding
      // back to a path two reviews in one session share.
      `Report\\s+${B}diffPath${B}\\s+=\\s+the\\s+SNAPSHOT_RUN_ROOT\\s+value\\s+with\\s+'/pr\\.diff'\\s+appended,\\s+ONLY\\s+if\\s+'gh pr diff'\\s+exited\\s+0`,
      "diffPath is not both bound to a value and gated on the exit code — the agent must infer the path from the redirect target",
    ],
    [`${B}prHead${B}\\s+=\\s+the\\s+headRefOid`, "prHead's value is not bound to the headRefOid"],
    [`${B}diffLines${B}\\s+=\\s+the\\s+wc\\s+-l\\s+count`, "diffLines' value is not bound to the wc -l count"],
    [
      "do\\s+not\\s+withhold\\s+one\\s+field\\s+because\\s+another\\s+failed",
      "one gh failure can suppress the fields that succeeded",
    ],
  ])
    assert.match(snapshot, new RegExp(re, "m"), missing);
});

// The functions are worthless if nothing calls them, and a text-lift pin tests a
// COPY: it stays green while the feature disconnects. Pin the CALL SITES.
test("the specialist prompt interpolates the read rules", () => {
  const prompt = slice("READ ONLY FROM THE SNAPSHOT", "Scratch files go in");
  assert.match(prompt, /\$\{readRules\(usableDiff\(snap\), stats, snap\)\}/);
  // `pr.diff` is a SIBLING of the snapshot tree, not a child of it — reading it
  // under an unqualified "READ ONLY FROM THE SNAPSHOT" is the exact
  // contradiction this branch's headline fix removes. Bound to the clause
  // itself (the `)` closing the HEAD parenthetical, then the qualifier), not
  // to "diff" appearing anywhere in the prompt: the `readRules` interpolation
  // this same prompt carries contains "Diff" in its own text, so a
  // presence-only check would stay green against a qualifier reading
  // "— nothing else." — which restores the original contradiction outright.
  // `\s+` between every word so a reflow of the same sentence stays green.
  assert.match(
    prompt,
    /READ ONLY FROM THE SNAPSHOT:[\s\S]*?\)\s+—\s+plus\s+the\s+diff\s+file\s+named\s+below,\s+if\s+one\s+is\s+given\./,
    "the SNAPSHOT permission is not qualified to admit the diff file named below — the sibling-file contradiction FIX-1 removed is back",
  );
});

test("the refuter prompt interpolates the same read rules", () => {
  const prompt = slice("Try to REFUTE this finding", "Scratch: ");
  assert.match(prompt, /\$\{readRules\(usableDiff\(snap\), stats, snap\)\}/);
});

// A second declaration would let one call site silently bind a different body.
// `snapshotMissing` joined the list at #140, where the gap was measured live:
// a duplicate `function snapshotMissing` placed AFTER the real one left both
// this file and review-pr-snapshot-path.test.mjs at 22/22 green, because the
// lift regex's non-global `.match` grabs the FIRST declaration while JS runs
// the LAST — the tests exercise the real guard while review-pr.js executes the
// no-op. Only the duplicate-BEFORE case, the harmless one, was ever caught.
//
// The names are DERIVED from the source rather than listed here. A hardcoded
// list protects a function only if someone remembered to add its name, and
// twice nobody did: #140 shipped with `snapshotMissing` absent from it, and
// #653 found the list had frozen at exactly the names lifted by the two files
// that wrote it — this one and review-pr-snapshot-path.test.mjs. Every function
// a LATER lift file came to depend on was unguarded, so a duplicate placed
// after the real declaration stayed invisible to the very file lifting it.
// Deriving covers the next top-level `function` on arrival, in each form one
// can be written in here: `async`, a generator star, any spacing around the
// name. Not `export function` — review-pr.js compiles as a function body inside
// the harness VM, so a second `export` is a syntax error rather than a silent
// rebind, and the parse test at the bottom of this file is what reds on it.
//
// Top-level `function` only. The values other files lift with a `const` regex
// — `DEFAULT_DIMENSIONS`, `verifiersFor` — are excluded for the same reason: a
// second `const` of the same name in the same scope is a SyntaxError, so it can
// never hoist past the real one, and that same parse test catches it.
//
// Known ceiling: the `^` anchor is the whole mechanism, so a string literal
// whose content begins a line with a declaration is counted as one. Whole-line
// comments cannot reach here, since `CODE` is stripped, but a template
// literal's interior is real text. Nothing in review-pr.js puts a declaration
// at the start of a line inside one today, and narrowing further would cost the
// property that a function nobody thought to list is covered anyway.
function topLevelFunctionNames(code) {
  return [...code.matchAll(/^(?:async[ \t]+)?function[ \t*]+(\w+)[ \t]*\(/gm)].map((m) => m[1]);
}

test("each function is declared exactly once at top level", () => {
  const names = topLevelFunctionNames(CODE);
  // A floor, not a count. `matchAll` yields an empty list rather than throwing,
  // so with nothing here the loop below would inspect no declaration and still
  // pass. It is a backstop rather than this file's first line of defence — the
  // module-scope lifts above name the functions they need and throw before any
  // test registers, so a derivation gutted today reds there first and louder.
  // A pinned total was rejected on purpose: the count has only ever grown, and
  // a `>=` decays silently as it does — the hardcoded-list failure above
  // wearing a different operator.
  assert.ok(
    names.length > 0,
    "no top-level function declarations found in review-pr.js — this guard is not looking at anything",
  );
  for (const name of new Set(names)) {
    const hits = names.filter((n) => n === name).length;
    assert.equal(hits, 1, `${name} is declared ${hits} times`);
  }
});

// The other half of the guard: what it must NOT refuse. A name may legitimately
// appear more than once — as a shadowing local, a nested declaration, a method
// on an object literal, or inside a string — and none of those can hoist over
// the real declaration. If the guard red on them, the next honest edit to
// review-pr.js would fail a test with no way to satisfy it.
test("the declared-exactly-once guard accepts the benign repeats of a name", () => {
  const benign = [
    "function unrunReason(review) {",
    '  const unrunReason = "a shadowing local, not a declaration";',
    "  function unrunReason(nested) { return nested; }",
    "  const handlers = {",
    "    unrunReason(review) { return null; },",
    "  };",
    "  log(`the text function unrunReason( inside a template literal`);",
    "  return unrunReason;",
    "}",
  ].join("\n");
  assert.deepEqual(
    topLevelFunctionNames(benign),
    ["unrunReason"],
    "the guard counts a benign repeat as a second declaration — an honest edit to review-pr.js cannot go green",
  );
});

// Nothing pinned this line, and its own comment says the feature is unobservable
// without it: deleting the whole `log()` call left the repo-wide suite at
// 283/283. That is how it shipped stating a measurement never taken — the clause
// chain printed `diff is 0 lines` for an ABSENT `diffLines`, so a run where
// `gh pr diff` produced 500 real lines and only `wc -l` failed read as an empty
// PR and nobody looked at `wc`. Both deferred follow-ups in the spec read this
// line for their evidence. Shape from `select-dimensions.test.mjs`'s
// `reviewDispatchOptions`: match the call, then assert on what it prints.
test("the no-diff log reports the raw fields, not a guard it did not measure", () => {
  const m = CODE.match(/^log\(\n\s*usable[\s\S]*?^\);$/m);
  assert.ok(m, "the diff-decision log line is gone — `usableDiff` returning null forever is then invisible");
  for (const field of ["diffPath", "diffLines", "prHead"]) {
    assert.match(
      m[0],
      new RegExp(`${field}=\\$\\{snap\\.${field}`),
      `the no-diff log does not print raw ${field} — the reader cannot tell absent from zero`,
    );
  }
  // The exact regression: a message asserting a count that was never reported.
  assert.doesNotMatch(
    m[0],
    /diff is 0 lines/,
    "an absent diffLines is reported as a measured 0 — a failed read and an empty read are indistinguishable again",
  );
  assert.match(m[0], /\(absent\)/, "an omitted field prints as empty rather than saying it was omitted");
});

// Every reader in this repo lifts text by regex or `new Function` over a
// fragment, so a syntax error anywhere in the fleet's DEFAULT review path ships
// with all five green — verified by inserting `const = ;`.
//
// `node --check` cannot do it: package.json is `commonjs`, and the file is
// neither a module (top-level `return`, legal only because the Workflow harness
// wraps the body) nor a script (`export const meta`). AsyncFunction is the one
// parser that accepts both — and it COMPILES without executing, which matters
// because importing this file runs the workflow.
test("review-pr.js parses — no other reader in this repo would notice a syntax error", () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(
    () =>
      new AsyncFunction(
        "args",
        "budget",
        "agent",
        "parallel",
        "pipeline",
        "phase",
        "log",
        "workflow",
        SOURCE.replace(/^export /m, ""),
      ),
    "workflows/review-pr.js does not parse",
  );
});
