import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between } from "./prose-pin.mjs";
import { lift } from "./lift.mjs";
import * as core from "./review-core.js";

// The pin for the shape #1349 chose (review-core.js's own header explains
// WHY): review-core.js is the canonical, tested source of every host-
// independent declaration; workflows/review-pr.js keeps a text-identical
// COPY of every pure function's CODE (comments may legitimately differ —
// review-core.js does not repeat review-pr.js's historical rationale prose,
// to avoid a second copy of PROSE disconnecting the way a second copy of
// CODE already does in this repo). Behavior parity is what actually matters,
// so every function below is run through the SAME fixtures on both sides —
// the review-pr.js copy lifted out of its source text (the Workflow sandbox
// forbids `import`, so this is the same technique every other review-pr.js
// test file uses), review-core.js's copy imported normally.
const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");
const CODE = stripComments(SOURCE);

test("usableDiff agrees on both sides", () => {
  const prFn = lift(CODE, "usableDiff", "snap");
  const fixtures = [
    { runRoot: "/s/pr7/run-ab", diffPath: "/s/pr7/run-ab/pr.diff", diffLines: 12, head: "abc123", refHead: "abc123def" },
    { runRoot: "/s/pr7/run-ab", diffPath: undefined, diffLines: 12, head: "abc123" },
    { runRoot: "/s/pr7/run-ab", diffPath: "/s/pr7/run-ab/pr.diff", diffLines: 0, head: "abc123" },
    { runRoot: "/s/pr7/run-ab", diffPath: "/s/pr7/run-ab/pr.diff", diffLines: 5, head: "abc123", refHead: "zzzzzz" },
    // #1513's shape: the ref matches the tree and the PR object lags it. Rows
    // carrying only `prHead` cannot cover this — the field is inert on both
    // sides now, so they agree by both skipping the compare.
    { runRoot: "/s/pr7/run-ab", diffPath: "/s/pr7/run-ab/pr.diff", diffLines: 5, head: "abc123", refHead: "abc123def", prHead: "zzzzzz" },
  ];
  for (const f of fixtures) assert.equal(core.usableDiff(f), prFn(f), JSON.stringify(f));
});

test("readRules agrees on both sides", () => {
  const prFn = lift(CODE, "readRules", "diffPath, stats, snap");
  const snap = { runRoot: "/s/pr7/run-ab", diffPath: "/s/pr7/run-ab/pr.diff", diffLines: 12, head: "abc123", refHead: "abc123def", prHead: "c774756" };
  const LIST = { paths: [{ path: "a.js", loc: 5 }, { path: "b.js", loc: 3 }] };
  const fixtures = [
    // A usable diff — the "read it first" branch.
    ["/s/pr7/run-ab/pr.diff", null, snap],
    // No diff, but a real file list.
    [null, LIST, { ...snap, diffPath: undefined }],
    // A truncated file list.
    [null, { paths: [{ path: "a.js", loc: 5 }], truncated: 100 }, { ...snap, diffPath: undefined }],
    // Every rejection reason, each with a file list: `rejected` is only
    // interpolated where `stats.paths.length` is truthy, so a rejection row
    // carrying `stats: null` takes the no-file-list branch and compares nothing
    // about the label. Measured against the fixture set that carried `null`
    // there — not one of its rows produced a `REJECTED` string on either side,
    // so the label was an expression with a copy per harness and no parity pin
    // over it (#1131).
    //
    // Skew: diffPath dropped, but the snapshot still reported one, for a head
    // the PR's own does not match.
    [null, LIST, { ...snap, diffPath: "/s/pr7/run-ab/pr.diff", head: "zzzzzz" }],
    // Empty: a count came back and it measured 0.
    [null, LIST, { ...snap, diffPath: "/s/pr7/run-ab/pr.diff", diffLines: 0 }],
    // Unmeasured: `wc -l` failed, so no count came back at all. Spelled out
    // rather than spread, so `diffLines` is genuinely absent.
    [null, LIST, { runRoot: "/s/pr7/run-ab", diffPath: "/s/pr7/run-ab/pr.diff", head: "abc123", refHead: "abc123def" }],
    // Nothing at all — no diff, no file list.
    [null, null, { ...snap, diffPath: undefined }],
  ];
  for (const [diffPath, stats, s] of fixtures)
    assert.equal(core.readRules(diffPath, stats, s), prFn(diffPath, stats, s), JSON.stringify({ diffPath, stats, s }));
});

// #1056. Both branches and the three ways `repoVerified` can fail to be true —
// false, absent, and a non-boolean the `=== true` compare must also reject.
// The reason string rides through the false branch, so a copy that dropped it
// reds here rather than in a live review's payload.
test("environmentNote agrees on both sides", () => {
  const prFn = lift(CODE, "environmentNote", "snap");
  const fixtures = [
    { repoVerified: true },
    { repoVerified: false, repoError: "SNAPSHOT_INIT_FAILED" },
    { repoVerified: false, repoError: "SNAPSHOT_TREE_MISMATCH=snapshot aaa vs commit bbb" },
    { repoVerified: false },
    { repoVerified: "true" },
    {},
    null,
  ];
  for (const f of fixtures) assert.equal(core.environmentNote(f), prFn(f), JSON.stringify(f));
});

test("resolveTestCmd agrees on both sides", () => {
  const prFn = lift(CODE, "resolveTestCmd", "explicit, snap");
  assert.equal(core.resolveTestCmd("node --test", null), prFn("node --test", null));
  assert.equal(core.resolveTestCmd(undefined, { testCmd: "npm test" }), prFn(undefined, { testCmd: "npm test" }));
  assert.throws(() => core.resolveTestCmd(undefined, null));
  assert.throws(() => prFn(undefined, null));
});

test("decodeArgs agrees on both sides", () => {
  const prFn = lift(CODE, "decodeArgs", "a");
  assert.deepEqual(core.decodeArgs('{"pr":7}'), prFn('{"pr":7}'));
  assert.deepEqual(core.decodeArgs({ pr: 7 }), prFn({ pr: 7 }));
  assert.deepEqual(core.decodeArgs(undefined), prFn(undefined));
});

test("snapshotMissing agrees on both sides", () => {
  const prFn = lift(CODE, "snapshotMissing", "snap, runRootPrefix");
  const PREFIX = "/scr/pr7/run-";
  const ROOT = `${PREFIX}ab12cd34`;
  const SNAP = `${ROOT}/snapshot-abc123`;
  const fixtures = [
    null,
    { path: SNAP, head: "abc", runRoot: ROOT, pathVerified: true },
    { path: SNAP, head: "abc", runRoot: ROOT, pathVerified: false },
    { head: "abc", runRoot: ROOT, pathVerified: true },
    { path: SNAP, runRoot: ROOT, pathVerified: true },
    { path: SNAP, head: "abc", runRoot: "/somewhere/else", pathVerified: true },
    // The head compare, which no row above reaches: every one of them omits the
    // operand entirely, so both copies agree by both skipping it. #1513 moved
    // that operand off `prHead`, and a copy left on the old field would still
    // pass every row above.
    { path: SNAP, head: "abc", runRoot: ROOT, pathVerified: true, refHead: "abcdef0" },
    { path: SNAP, head: "abc", runRoot: ROOT, pathVerified: true, refHead: "zzz" },
    { path: SNAP, head: "abc", runRoot: ROOT, pathVerified: true, refHead: "abcdef0", prHead: "zzz" },
  ];
  for (const f of fixtures) assert.equal(core.snapshotMissing(f, PREFIX), prFn(f, PREFIX), JSON.stringify(f));
});

test("unrunReason/unrunEntries/unrunCrashed agree on both sides", () => {
  const seam = [
    "unrunReason(review)",
    "unrunEntries(review, dimension)",
    "unrunCrashed(reviewed, dimensions)",
  ];
  const src = seam.map((sig) => {
    const name = sig.slice(0, sig.indexOf("("));
    const params = sig.slice(sig.indexOf("(") + 1, -1);
    return `function ${name}(${params}) {\n${
      CODE.match(new RegExp(`^function ${name}\\(${params.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) \\{([\\s\\S]*?)^\\}$`, "m"))[1]
    }}`;
  }).join("\n");
  const { unrunReason: prUnrunReason, unrunEntries: prUnrunEntries, unrunCrashed: prUnrunCrashed } = new Function(
    `${src}\nreturn { unrunReason, unrunEntries, unrunCrashed };`,
  )();

  const reviews = [
    null,
    { test_run: null },
    { test_run: { command: "node --test", tests: 0 } },
    { test_run: { command: "node --test", tests: 10, pass: 10, fail: 0 }, findings: [] },
    { test_run: { command: "node --test", tests: 10, pass: 3, fail: 0 }, findings: [] },
    { test_run: { command: "node --test", tests: 10, pass: 0, fail: 2 }, findings: [] },
  ];
  for (const r of reviews) {
    assert.equal(core.unrunReason(r), prUnrunReason(r), JSON.stringify(r));
    assert.deepEqual(core.unrunEntries(r, "correctness"), prUnrunEntries(r, "correctness"));
  }
  const reviewed = [{ findings: [] }, null, { test_run: { command: "x", tests: 0 } }];
  const dims = [{ key: "a" }, { key: "b" }, { key: "c" }];
  assert.deepEqual(core.unrunCrashed(reviewed, dims), prUnrunCrashed(reviewed, dims));
});

test("verdictFor agrees on both sides", () => {
  const prFn = lift(CODE, "verdictFor", "dispatched, votes");
  const fixtures = [
    [0, []],
    [2, []],
    [2, [{ refuted: true }, { refuted: true }]],
    [2, [{ refuted: true }, { refuted: false }]],
    [2, [{ refuted: false }, { refuted: false }]],
  ];
  for (const [dispatched, votes] of fixtures)
    assert.deepEqual(core.verdictFor(dispatched, votes), prFn(dispatched, votes), JSON.stringify({ dispatched, votes }));
});

test("selectDimensions agrees on both sides", () => {
  const prAll = new Function(
    `${CODE.match(/^const DEFAULT_DIMENSIONS = \[[\s\S]*?^\];$/m)[0]}\nreturn DEFAULT_DIMENSIONS;`,
  )();
  const prSizeTierProfiles = CODE.match(/^const SIZE_TIER_PROFILES = new Set\(\[[^\]]*\]\);$/m)[0];
  const prSizeTierDims = CODE.match(/^const SIZE_TIER_DIMS = new Set\(\[[^\]]*\]\);$/m)[0];
  const fnSrc = CODE.match(/^function selectDimensions\(all, stats\) \{[\s\S]*?^\}$/m)[0];
  const prFn = new Function(`${prSizeTierProfiles}\n${prSizeTierDims}\n${fnSrc}\nreturn selectDimensions;`)();

  const statsFixtures = [
    null,
    { profile: "production" },
    { profile: "production", hasTests: false },
    { profile: "production", hasSrc: false },
    { profile: "production", hasSrc: false, hasTests: false, hasConfig: true },
    { profile: "single-file" },
    { profile: "single-file", hasTests: true },
    { profile: "small", hasTests: true },
    { docsOnly: true },
    { truncated: 5 },
  ];
  for (const stats of statsFixtures) {
    const coreKeys = core.selectDimensions(core.DEFAULT_DIMENSIONS, stats).map((d) => d.key);
    const prKeys = prFn(prAll, stats).map((d) => d.key);
    assert.deepEqual(coreKeys, prKeys, JSON.stringify(stats));
  }
});

test("resolveDimensions agrees on both sides", () => {
  const prAll = new Function(
    `${CODE.match(/^const DEFAULT_DIMENSIONS = \[[\s\S]*?^\];$/m)[0]}\nreturn DEFAULT_DIMENSIONS;`,
  )();
  const prFn = lift(CODE, "resolveDimensions", "override, all");
  // Thrown-vs-returned, not returned alone (#1556). WHICH overrides the two
  // copies REFUSE is as much of their shared contract as what they return for
  // the rest, and a loop comparing return values only cannot see a
  // disagreement there — the first side to throw aborts the test before the
  // other is ever called. The message is compared too: the two copies are
  // text-identical CODE by this file's whole premise, so a refusal that names
  // a different reason on each host is itself a divergence.
  const outcome = (fn) => {
    try {
      return { returned: fn()?.map((d) => d.key) ?? null };
    } catch (e) {
      return { threw: e.message };
    }
  };
  // `JSON.stringify(NaN)` renders the string "null", which collides with the
  // `null` fixture's label below. `JSON.stringify(undefined)` returns the
  // bare `undefined` value (not a string) — that's what this helper's own
  // `?? "undefined"` fallback arm covers; it has nothing to do with NaN.
  const label = (v) => (Number.isNaN(v) ? "NaN" : JSON.stringify(v) ?? "undefined");
  // The falsy-but-PRESENT class (#1125): `override == null` refuses these,
  // where the `!override` guard it replaced returned `null` for them and
  // silently handed the run back to the size tier. This fixture used to hold
  // only `undefined`/`null` and valid arrays, so EITHER copy could carry that
  // regression alone and this parity pin stayed green — measured on a scratch
  // tree with review-core.js's guard reverted to `!override`: every test in
  // this file passed, and so did every test in select-dimensions.test.mjs,
  // which lifts its own falsy pin out of review-pr.js's SOURCE TEXT and so
  // never runs review-core.js's copy at all.
  const falsyPresent = ["", 0, false, NaN];
  const modelOverride = [{ key: "x", prompt: "p", agentType: "a", model: "opus" }];
  const overrides = [
    undefined,
    null,
    ...falsyPresent,
    ["correctness", "comments"],
    [{ key: "x", prompt: "p", agentType: "a" }],
    modelOverride,
  ];
  for (const o of overrides)
    assert.deepEqual(
      outcome(() => core.resolveDimensions(o, core.DEFAULT_DIMENSIONS)),
      outcome(() => prFn(o, prAll)),
      label(o),
    );
  // Agreement alone cannot see the two copies regressing TOGETHER, and
  // review-core.js's copy has no other pin on this refusal. So assert the
  // refusal itself, on each side, rather than only that the two agree.
  for (const o of falsyPresent) {
    assert.throws(
      () => core.resolveDimensions(o, core.DEFAULT_DIMENSIONS),
      /must be an array/,
      `review-core.js accepted the falsy-but-present override ${label(o)}`,
    );
    assert.throws(() => prFn(o, prAll), /must be an array/, `review-pr.js accepted the falsy-but-present override ${label(o)}`);
  }
  // Both refuse a `model` field identically.
  assert.throws(() => core.resolveDimensions(modelOverride, core.DEFAULT_DIMENSIONS));
  assert.throws(() => prFn(modelOverride, prAll));
});

// The DEFAULT_DIMENSIONS arrays: same keys, same prompts, same length — and
// the ONE allowed difference between the two copies (see review-core.js's own
// header) is the `agentType` string, namespaced on the Claude side.
test("DEFAULT_DIMENSIONS agrees on key/prompt and differs from review-pr.js's copy ONLY by the fleet-ctl: namespace", () => {
  const prAll = new Function(
    `${CODE.match(/^const DEFAULT_DIMENSIONS = \[[\s\S]*?^\];$/m)[0]}\nreturn DEFAULT_DIMENSIONS;`,
  )();
  assert.equal(core.DEFAULT_DIMENSIONS.length, prAll.length);
  for (let i = 0; i < prAll.length; i++) {
    assert.equal(core.DEFAULT_DIMENSIONS[i].key, prAll[i].key);
    assert.equal(core.DEFAULT_DIMENSIONS[i].prompt, prAll[i].prompt);
    assert.equal(prAll[i].agentType, `fleet-ctl:${core.DEFAULT_DIMENSIONS[i].agentType}`);
    assert.equal(prAll[i].model, undefined);
    assert.equal(core.DEFAULT_DIMENSIONS[i].model, undefined);
  }
});

// The snapshot and verifier dispatches: review-pr.js's `agentType` literal is
// the SAME namespacing rule applied to the two agentType strings
// review-core.js's `runReview` hardcodes (not part of DEFAULT_DIMENSIONS).
test("the snapshot and verifier dispatches follow the same fleet-ctl: namespacing rule", () => {
  assert.match(SOURCE, /agentType:\s*"fleet-ctl:fleet-review-snapshot"/);
  assert.match(readFileSync(join(REPO, "scripts", "review-core.js"), "utf8"), /agentType:\s*"fleet-review-snapshot"/);
  assert.match(SOURCE, /agentType:\s*"fleet-ctl:fleet-review-verifier"/);
  assert.match(readFileSync(join(REPO, "scripts", "review-core.js"), "utf8"), /agentType:\s*"fleet-review-verifier"/);
});

// FINDINGS_SCHEMA/VERDICT_SCHEMA: structurally identical (comments aside).
test("FINDINGS_SCHEMA and VERDICT_SCHEMA are structurally identical between the two copies", () => {
  const prFindings = new Function(`${CODE.match(/^const FINDINGS_SCHEMA = \{[\s\S]*?^\};$/m)[0]}\nreturn FINDINGS_SCHEMA;`)();
  const prVerdict = new Function(`${CODE.match(/^const VERDICT_SCHEMA = \{[\s\S]*?^\};$/m)[0]}\nreturn VERDICT_SCHEMA;`)();
  assert.deepEqual(core.FINDINGS_SCHEMA, prFindings);
  assert.deepEqual(core.VERDICT_SCHEMA, prVerdict);
});

// SNAPSHOT_SCHEMA had no parity pin at all, and #1056 is what made that a live
// risk rather than a latent one: the two copies now carry a `required` list of
// five, and a field added to one harness only is a review that validates less
// than its sibling with every other pin green. Compared as the schema's
// substance — the `required` set and each property's declared type — rather
// than as text, because review-pr.js's copy is inline in its `agent()` options
// while review-core.js's is a module-scope const, so the two can never be
// byte-identical and a text pin would have to be written loose enough to pass
// on a real divergence.
test("SNAPSHOT_SCHEMA agrees on required fields and declared types between the two copies", () => {
  const inline = between(CODE, 'agentType: "fleet-ctl:fleet-review-snapshot", schema: {', "\n    } }", "review-pr.js's inline snapshot schema");
  const required = inline.match(/required: \[([^\]]*)\]/);
  assert.ok(required, "review-pr.js's inline snapshot schema no longer declares a `required` array — update this test");
  assert.deepEqual(
    required[1].split(",").map((f) => f.trim().replace(/"/g, "")).sort(),
    [...core.SNAPSHOT_SCHEMA.required].sort(),
    "the two copies of the snapshot schema require different fields — one harness accepts a report the other refuses",
  );
  const declared = [...between(inline, "properties: {", "\n      },", "review-pr.js's snapshot properties").matchAll(/^\s*(\w+): \{ type: "(\w+)"/gm)]
    .map((m) => `${m[1]}:${m[2]}`)
    .sort();
  assert.deepEqual(
    declared,
    Object.entries(core.SNAPSHOT_SCHEMA.properties).map(([k, v]) => `${k}:${v.type}`).sort(),
    "the two copies declare different snapshot fields — `additionalProperties: false` then drops on one harness what the other accepts",
  );
});

// `resumeFor` is the ONE declared exception (review-core.js's own header
// comment says so) — pin that the two Claude-branch messages AGREE on every
// word except the resume verb itself, rather than pinning them identical.
test("resumeFor's claude branch matches review-pr.js's own message, up to the resume verb", () => {
  const prFn = lift(CODE, "resumeFor", "unverified");
  const unverified = [{ refutersDispatched: 2 }];
  const prResult = prFn(unverified);
  const coreResult = core.resumeFor(unverified, "claude");
  assert.deepEqual(coreResult.crashed, prResult.crashed);
  const prClaim = prResult.resume.split("Resume before deferring them: ")[0];
  const coreClaim = coreResult.resume.split("Resume before deferring them: ")[0];
  assert.equal(coreClaim, prClaim, "the shared claim clause diverged between the two copies");
  assert.match(prResult.resume, /resumeFromRunId/);
  assert.match(coreResult.resume, /resumeFromRunId/);
});

test("resumeFor's omp branch reports re-run, never resumeFromRunId", () => {
  const unverified = [{ refutersDispatched: 2 }];
  const result = core.resumeFor(unverified, "omp");
  assert.match(result.resume, /re-run/);
  assert.doesNotMatch(result.resume, /resumeFromRunId/);
});

// #878, and the one half of that guard this repo can EXECUTE. review-pr.js
// cannot be imported, so its copy is pinned by source position
// (shared-refusal.test.mjs); review-core.js is an ordinary module, so the
// refusal itself can be run — and running it is what proves the ordering claim
// both files make, which a position assertion only describes.
//
// The dispatch counter is the load-bearing assertion. A throw alone is
// reproducible by a LATER failure: leave the guard out and `agent()` is called,
// the stub returns nothing usable, and runReview throws anyway — same
// rejection, after paying for the snapshot agent and the run root it mkdirs.
// Zero dispatches is the only evidence the refusal landed first.
//
// "my-branch" rather than "abc" because it is the value that actually gets in:
// `gh` resolves a non-numeric ref as a BRANCH, so the snapshot would be a real
// diff belonging to whatever PR that branch heads, reported under the string
// that was passed.
test("#878: runReview refuses a non-numeric args.pr before dispatching any agent", async () => {
  let dispatched = 0;
  const host = {
    agent: async () => {
      dispatched++;
      return null;
    },
    phase: () => {},
    log: () => {},
  };
  await assert.rejects(
    () => core.runReview(host, { pr: "my-branch", worktree: "/tmp/wt" }),
    /args\.pr must be a PR number, got "my-branch"/,
  );
  assert.equal(dispatched, 0, "a non-numeric pr bought an agent dispatch before being refused");

  // The must-ACCEPT direction, on the same harness: the fleet holds a PR
  // number as a NUMBER, so a guard that lost isDigits()'s coercion would
  // refuse every real invocation while still refusing every bad one. Proven by
  // getting PAST this guard to the snapshot dispatch — the stub's null return
  // fails later, which is a different rejection and one this assertion does
  // not read.
  dispatched = 0;
  await assert.rejects(() => core.runReview(host, { pr: 42, worktree: "/tmp/wt" }));
  assert.equal(dispatched, 1, "a numeric pr was refused before the snapshot dispatch it must reach");
});

// #1616 fix-review finding 3: `refHead`'s omission rule is PROSE, not one of
// the byte-identical function bodies above — review-core.js's own header
// (top of this file) says its copy legitimately omits review-pr.js's
// historical rationale, so the two paragraphs are not expected to be
// byte-identical text. But the RULE both must state — omit `refHead` only
// when every read this PR was entitled to came back empty, failed, or was
// skipped, and treat that as neither a match nor a mismatch — is not
// optional, and nothing above pins it: deleting the rule from
// review-core.js's prompt text left every other test in this repo green.
const CORE_SOURCE = readFileSync(join(REPO, "scripts", "review-core.js"), "utf8");
const REFHEAD_OMISSION_RULE =
  /Omit[\s\S]{0,10}refHead[\s\S]{0,10}when\s+every\s+read\s+this\s+PR\s+was\s+entitled\s+to\s+came\s+back\s+empty[\s\S]{0,250}neither\s+a\s+match\s+nor\s+a\s+mismatch/;
test("the refHead-omission rule agrees on both harness copies", () => {
  const prSnapshot = between(CODE, "const snap = await agent(", "if (!snap", "review-pr.js's snapshot dispatch");
  const coreSnapshot = between(CORE_SOURCE, "const snap = await agent(", "if (snap) {", "review-core.js's snapshot dispatch");
  assert.match(prSnapshot, REFHEAD_OMISSION_RULE, "review-pr.js no longer states the refHead-omission rule this way");
  assert.match(coreSnapshot, REFHEAD_OMISSION_RULE, "review-core.js no longer states the refHead-omission rule this way");
});
