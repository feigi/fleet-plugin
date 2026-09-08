import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between } from "./prose-pin.mjs";
import { lift } from "./lift.mjs";

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
const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// Every pin below runs against CODE, not SOURCE — the same policy, and now the
// same stripper, as `review-pr-reads.test.mjs`. Written against raw source,
// this file's schema-declaration pin was VACUOUS: wrapping the real
// `testCmd: { type: "string" },` in a `/* */` block left the suite 9 pass / 0
// fail while `additionalProperties: false` silently dropped the field at
// runtime, breaking the very derivation #142 adds. The `^\s*` anchor those
// pins use rejects a leading `//` and nothing else. Measured, #142 review.
const CODE = stripComments(SOURCE);

// review-pr.js runs a top-level `await pipeline(...)` and cannot be imported,
// so resolveTestCmd is lifted out of the source text instead — same technique
// as `select-dimensions.test.mjs` and `review-pr-reads.test.mjs`, via the
// shared lift() in lift.mjs.
const resolveTestCmd = lift(CODE, "resolveTestCmd", "explicit, snap");

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
    CODE,
    /^const testCmd = resolveTestCmd\(A\.testCmd, snap\);$/m,
    "the testCmd call site changed — the derivation may be disconnected",
  );
  // Textually after the snapshot's own validity guard, not before — snap must
  // be known good (or the throw above already fired) before this reads it.
  // Anchored on the guard's INVOCATION — not its declaration, and not one of
  // its return messages. The declaration sits above every top-level statement
  // in this file, so ordering against it is near-tautological: measured, it
  // stays green with the resolveTestCmd call moved ahead of the guard, which
  // is the one regression this assertion's message names. A message anchor is
  // reword-fragile instead — #539 split the single "no tree" message into
  // three, and the retired literal leaves guardAt at -1, which reds this
  // assertion loudly rather than silently, but reds it all the same. The call
  // site is the only anchor that is both reword-proof and order-sensitive.
  const guardAt = CODE.indexOf("const missingReason = snapshotMissing(snap, runRootPrefix);");
  const callAt = CODE.indexOf("const testCmd = resolveTestCmd(");
  assert.ok(guardAt !== -1 && callAt !== -1 && callAt > guardAt, "resolveTestCmd is called before snap is validated");
});

// A hardcoded default anywhere in this file is the exact regression #142
// fixes — `A.testCmd || "<literal>"` is the shape it used to take.
test("no hardcoded testCmd default remains", () => {
  assert.doesNotMatch(
    CODE,
    /A\.testCmd\s*\|\|\s*"/,
    "a literal testCmd default reappeared — it must come from resolveTestCmd/derive-testcmd.sh instead",
  );
});

// The snapshot agent's return schema gains testCmd/testCmdError the same way
// diffPath/diffLines/prHead were added: `additionalProperties: false` drops
// an undeclared field silently, so BOTH the prompt asking for it and the
// schema declaring it have to be pinned, or the feature disconnects in one
// token exactly like `review-pr-reads.test.mjs`'s "the snapshot agent asks for
// the diff facts AND declares them in its schema" records happening to the
// diff facts.
test("the snapshot agent is told to derive testCmd AND the schema declares it", () => {
  const snapshot = between(CODE, "const snap = await agent(", "if (!snap", "the snapshot agent dispatch");

  assert.match(
    snapshot,
    /~\/dev\/fleet-plugin\/scripts\/derive-testcmd\.sh \$\{worktree\} HEAD/,
    "the snapshot agent no longer runs derive-testcmd.sh",
  );
  // Deriving the command is half the job — it also has to RUN where the
  // specialists are told to run it. `git archive` carries tracked files only,
  // so `npm test --` (the derivation's first branch, for any repo whose
  // scripts.test invokes a node_modules binary) exits 127 in the snapshot
  // while passing in the worktree the derivation was run against. Measured on
  // a synthetic repo during the #142 review: worktree exit 0, archive exit 127.
  assert.match(
    snapshot,
    // `"$SNAP/node_modules"` since #1129: the destination is a per-run shell
    // variable now, and the symlink has to land in the tree this run actually
    // extracted — a link left at the old bare `${scratch}/snapshot` would
    // provision node_modules for a directory no specialist is pointed at.
    // Quote-tolerant on purpose. The needle's job is that the symlink lands in
    // THIS run's destination — `$SNAP`, never the old bare `${scratch}/snapshot`
    // — and `"$SNAP/node_modules"` and `"$SNAP"/node_modules` are the same word
    // to any POSIX shell, `/node_modules` carrying no metacharacters. Pinning
    // one of the two rejected a behaviour-identical rewrite as a #1129
    // regression, which is how a pin teaches its next reader to weaken it.
    //
    // The `[ -n "$SNAP" ]` half is not decoration either: this is the only
    // command in the block whose target no earlier line created, so it is the
    // only one that would still act on an empty `$SNAP` — writing a symlink at
    // `/node_modules`, outside the run root entirely.
    // Order-agnostic between the two `[ ]` tests, for the same reason the
    // quotes are optional: swapping them is behaviour-identical, so pinning
    // one arrangement would red a correct change.
    /if [^\n]*\[ -n "\$SNAP" \][^\n]*; then ln -s \$\{worktree\}\/node_modules "?\$SNAP"?\/node_modules"?/,
    "the snapshot no longer provisions node_modules — a derived `npm test --` cannot run in it",
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

  // Scoped to the `properties` object, not the whole schema: a field declared
  // ANYWHERE else is undeclared as far as `additionalProperties: false` is
  // concerned, and an unbounded slice covering the rest of the block passes on
  // it anyway. `between()` for the end anchor too — measured: move a field out
  // of `properties` and re-indent the close, and the raw `indexOf` form here
  // returned -1, widened to nearly the whole block, and stayed green.
  const props = between(snapshot, "properties: {", "\n      },", "the snapshot schema");
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
  // required-field validation error one layer down. `pathVerified` joins
  // path+head instead (#140): unlike testCmd, its absence must abort.
  assert.match(
    snapshot,
    /required:\s*\["runRoot",\s*"path",\s*"head",\s*"pathVerified"\]/,
    "required must stay path+head+pathVerified only",
  );
});

// The prompt is what specialists actually obey, so the reading rule has to be
// in it. Without this, a specialist that guesses a glob still reports
// `tests 0` as a pass — the exact failure the derivation alone does not cover.
test("the specialist prompt hands the command over verbatim and rules 'tests 0' a failure", () => {
  // indexOf returns -1 when absent and slice(-1) is a truthy one-character
  // string, so asserting on the slice passes with the prompt gone. Assert the
  // index — and bound the END too: unbounded, this slice ran to EOF and the
  // assertions below were satisfiable from the verifier prompt further down.
  const prompt = between(CODE, "READ ONLY FROM THE SNAPSHOT", "Scratch files go in", "the specialist prompt");
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
  // The RULING was pinned and the INSTRUCTION was not, so the sentence telling
  // specialists not to swap the command out could be deleted with this suite
  // green (#143). Everything around it explains why; this is the only clause
  // that actually forbids anything.
  assert.match(
    prompt,
    /Do not substitute a command of your own\./,
    "the prompt no longer forbids substituting a command — only explains why one would be wrong",
  );
});

// #143's second correction. The rationale above asserted, present tense and as
// fact about the run being described, that a bare runner "tears down a shared
// container mid-run for every sibling". Measured against this repo:
// `derive-testcmd.sh` resolves `node --test` here and
// `commands/review-and-fix.md` records that this repo has no
// compose file, no `globalSetup`, and no vitest — so no teardown can happen,
// and a specialist that checks the reason it was given finds it false.
//
// The rule is still worth carrying, because review-pr.js reviews repos that DO
// have a stack. It has to be stated as a conditional about those repos rather
// than as a fact about this run.
test("the anti-substitution rationale is portable, not a present-tense claim about this run", () => {
  const prompt = between(CODE, "READ ONLY FROM THE SNAPSHOT", "Scratch files go in", "the specialist prompt");
  assert.doesNotMatch(
    prompt,
    /tears down a shared container mid-run for every sibling/,
    "the prompt again asserts a container teardown as fact about a run that cannot have one (#143)",
  );
  // The conditional that replaced it, and the half that is NOT conditional: a
  // zero-match glob exits 0 in every repo, so hedging that one would weaken a
  // rule this repo has actually measured (#142).
  assert.match(
    prompt,
    /In a repo that has a shared test stack/,
    "the container rationale is no longer scoped to the repos it can happen in",
  );
  assert.match(
    prompt,
    /a guessed glob is\s+worse in every repo/,
    "the zero-match-glob half is no longer stated as holding everywhere",
  );
});

// The rule #143 widened, in the place specialists actually read. The classifier
// catches the zero-pass case on its own (`review-pr-unrun.test.mjs`), but the
// partial-tree case it CANNOT: `unrunReason` is pure and never learns how many
// tests the whole tree has, so the only reader positioned to notice is the agent
// that ran the command. If this instruction goes, that case has no other guard.
test("the prompt rules a no-work run unrun too: zero passes, and a count below the whole tree", () => {
  const prompt = between(CODE, "READ ONLY FROM THE SNAPSHOT", "Scratch files go in", "the specialist prompt");
  assert.match(
    prompt,
    /0 passes with no failures is\s+everything skipped/,
    "the prompt no longer rules an all-skipped run a no-work run (#143)",
  );
  assert.match(
    prompt,
    /a count well below what the whole tree reports means you\s+ran a PARTIAL copy/,
    "the prompt no longer rules a partial-tree run unrun — the case nothing downstream can catch (#143)",
  );
});
