import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// review-pr.js used to default `testCmd` to a literal string naming THIS
// repo's own test path — silent green everywhere else, since `worktree` is a
// caller-supplied argument and a glob matching nothing exits 0 reporting
// `tests 0` (#142). It is now DERIVED from the repo under review by the
// snapshot agent (see the "derives this repository's own test command"
// paragraph below), reusing derive-testcmd.sh — see
// derive-testcmd.test.mjs for that script's own coverage, exercised against
// repos that are NOT this one, which is the guard #142's acceptance
// criteria required and an archive of this repo could not have been.
//
// This file covers what remains review-pr.js's own responsibility:
// resolveTestCmd's resolution order and refusal, the snapshot agent's prompt
// and schema actually carrying the derivation, and the specialist prompt
// still handing testCmd over verbatim with the 'tests 0' rule.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// review-pr.js runs a top-level `await pipeline(...)` and cannot be imported,
// so resolveTestCmd is lifted out of the SOURCE TEXT instead — same technique
// as `select-dimensions.test.mjs` and `review-pr-reads.test.mjs`.
function liftResolveTestCmd() {
  const m = SOURCE.match(/^function resolveTestCmd\(explicit, snap\) \{[\s\S]*?^\}$/m);
  assert.ok(m, "review-pr.js no longer declares resolveTestCmd(explicit, snap) at top level — update this test");
  return new Function(`${m[0]}\nreturn resolveTestCmd;`)();
}
const resolveTestCmd = liftResolveTestCmd();

test("an explicit override always wins, whatever the snapshot derived", () => {
  assert.equal(resolveTestCmd("npm test --", { testCmd: "node --test" }), "npm test --");
  assert.equal(resolveTestCmd("npm test --", null), "npm test --");
  assert.equal(resolveTestCmd("npm test --", { testCmdError: "refused" }), "npm test --");
});

test("no override falls back to the snapshot agent's derivation", () => {
  assert.equal(resolveTestCmd(undefined, { testCmd: "node --test" }), "node --test");
  assert.equal(resolveTestCmd(null, { testCmd: "npm test --" }), "npm test --");
});

// The whole point of #142: neither an override nor a derivation must REFUSE
// the review, never fall back to a guessed default.
test("no override and no derivation refuses, naming the snapshot agent's reason", () => {
  assert.throws(
    () => resolveTestCmd(undefined, { testCmdError: "HEAD has no scripts.test and no test files" }),
    /no test command for this repository — HEAD has no scripts\.test and no test files/,
  );
});

test("no override, no snapshot at all, and no testCmdError still refuses rather than crashing", () => {
  assert.throws(() => resolveTestCmd(undefined, null), /no test command for this repository/);
  assert.throws(() => resolveTestCmd(undefined, {}), /the snapshot agent did not derive one/);
});

// A falsy-but-present override (`""`) is caller error, not "no override" —
// the `||`/truthiness check above only distinguishes explicit from absent,
// and this pins that an empty string does NOT silently pass through as a
// command. It falls to the snapshot the same as `undefined` would.
test("an empty-string override is not treated as an explicit command", () => {
  assert.equal(resolveTestCmd("", { testCmd: "node --test" }), "node --test");
});

// The function is worthless if nothing calls it — pin the CALL SITE, not
// just the lifted copy. select-dimensions.test.mjs's #118 regression is this
// exact defect: replacing the call with a bare default left every test above
// green while the feature disconnected.
test("review-pr.js actually calls resolveTestCmd once the snapshot is validated", () => {
  assert.match(
    SOURCE,
    /^const testCmd = resolveTestCmd\(A\.testCmd, snap\);$/m,
    "the testCmd call site changed — the derivation may be disconnected",
  );
  // Textually after the snapshot's own validity guard, not before — snap must
  // be known good (or the throw above already fired) before this reads it.
  const guardAt = SOURCE.indexOf("the snapshot agent returned no tree");
  const callAt = SOURCE.indexOf("const testCmd = resolveTestCmd(");
  assert.ok(guardAt !== -1 && callAt !== -1 && callAt > guardAt, "resolveTestCmd is called before snap is validated");
});

// A hardcoded default anywhere in this file is the exact regression #142
// fixes — `A.testCmd || "<literal>"` is the shape it used to take.
test("no hardcoded testCmd default remains", () => {
  assert.doesNotMatch(
    SOURCE,
    /A\.testCmd\s*\|\|\s*"/,
    "a literal testCmd default reappeared — it must come from resolveTestCmd/derive-testcmd.sh instead",
  );
});

// The snapshot agent's return schema gains testCmd/testCmdError the same way
// diffPath/diffLines/prHead were added: `additionalProperties: false` drops
// an undeclared field silently, so BOTH the prompt asking for it and the
// schema declaring it have to be pinned, or the feature disconnects in one
// token exactly like `review-pr-reads.test.mjs:308-367` records happening to
// the diff facts.
test("the snapshot agent is told to derive testCmd AND the schema declares it", () => {
  const at = SOURCE.indexOf("const snap = await agent(");
  const end = SOURCE.indexOf("if (!snap", at);
  assert.notEqual(at, -1, "the snapshot agent dispatch moved — update this test");
  assert.notEqual(end, -1, "the snapshot agent's validity guard moved — update this test");
  const snapshot = SOURCE.slice(at, end);

  assert.match(
    snapshot,
    /~\/\.claude\/skills\/fleet\/scripts\/derive-testcmd\.sh \$\{worktree\} HEAD/,
    "the snapshot agent no longer runs derive-testcmd.sh",
  );
  // These names live inside a template literal, so each backtick is a
  // BACKSLASH-backtick in the source text — `\\?` matches it either way, the
  // same idiom `review-pr-reads.test.mjs` uses for diffPath/prHead/diffLines.
  const B = "\\\\?`";
  assert.match(
    snapshot,
    new RegExp(`Report\\s+${B}testCmd${B}\\s*=\\s*its\\s+stdout\\s+ONLY\\s+if\\s+it\\s+exited\\s+0`),
    "testCmd is not bound to the script's stdout and gated on its exit code",
  );
  assert.match(
    snapshot,
    new RegExp(`report\\s+${B}testCmdError${B}\\s*=\\s*its\\s+stderr`),
    "testCmdError is not bound to the script's stderr on refusal",
  );

  const props = snapshot.slice(snapshot.indexOf("properties: {"), snapshot.indexOf("\n      },"));
  for (const field of ["testCmd", "testCmdError"]) {
    assert.match(
      props,
      new RegExp(`^\\s*${field}:\\s*\\{\\s*type:`, "m"),
      `${field} is not declared in the schema's properties — additionalProperties:false drops it`,
    );
  }
  // Both stay OUT of `required`: a network or git failure inside
  // derive-testcmd.sh must not abort a snapshot that is otherwise good —
  // resolveTestCmd is what turns a missing derivation into a refusal, not a
  // required-field validation error one layer down.
  assert.match(snapshot, /required:\s*\["path",\s*"head"\]/, "required must stay path+head only");
});

// The prompt is what specialists actually obey, so the reading rule has to be
// in it. Without this, a specialist that guesses a glob still reports
// `tests 0` as a pass — the exact failure the derivation alone does not cover.
test("the specialist prompt hands the command over verbatim and rules 'tests 0' a failure", () => {
  // indexOf returns -1 when absent and slice(-1) is a truthy one-character
  // string, so asserting on the slice passes with the prompt gone. Assert the
  // index — and bound the END too: unbounded, this slice ran to EOF and the
  // assertions below were satisfiable from the verifier prompt further down.
  const at = SOURCE.indexOf("READ ONLY FROM THE SNAPSHOT");
  assert.notEqual(at, -1, "the specialist prompt moved — update this test");
  const end = SOURCE.indexOf("Scratch files go in", at);
  assert.notEqual(end, -1, "the specialist prompt's scratch line moved — update this test");
  const prompt = SOURCE.slice(at, end);
  // The worked example must INTERPOLATE testCmd, not restate it. A hardcoded
  // copy drifts from the resolved value the moment either one changes, and a
  // caller passing args.testCmd (or the derivation) would be handed the wrong
  // command.
  assert.match(
    prompt,
    /run exactly this[^\n]*\n\s*\$\{testCmd\}/,
    "the prompt no longer hands specialists the interpolated command verbatim",
  );
  // Match the ruling itself, not the phrase `tests 0` — that appears in the
  // surrounding explanation too, so a looser assertion passes with the rule
  // deleted (observed: it did).
  assert.match(
    prompt,
    /'tests 0' is a FAILED run/,
    "the prompt no longer rules a zero-test run a failure",
  );
});
