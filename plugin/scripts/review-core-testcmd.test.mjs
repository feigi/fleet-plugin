import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between } from "./prose-pin.mjs";
import { resolveTestCmd, SNAPSHOT_SCHEMA } from "./review-core.mjs";

// The review host used to default `testCmd` to a literal string naming THIS
// repo's own test path — silent green everywhere else, since `worktree` is a
// caller-supplied argument and a glob matching nothing exits 0 reporting
// `tests 0` (#142). It is now READ from the repo under review's Recipe cache by
// the snapshot agent (see the "derives this repository's own test command"
// paragraph below), through derive-testcmd.sh — see derive-testcmd.test.mjs
// for that script's own coverage, exercised against fixture repos that are
// NOT this one, which is the guard #142's acceptance criteria required and an
// archive of this repo could not have been.
//
// This file covers what remains review-core.mjs's own responsibility:
// resolveTestCmd's resolution order and refusal, the snapshot agent's prompt
// and schema actually carrying the derivation, and the shared test-run
// prompt (#2315) handing testCmd over verbatim with the 'tests 0' rule — the
// one prompt that runs it, since no specialist runs the full suite any more.
const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "scripts", "review-core.mjs"), "utf8");

// Every pin below runs against CODE, not SOURCE — the same policy, and now the
// same stripper, as `review-core-reads.test.mjs`. Written against raw source,
// this file's schema-declaration pin was VACUOUS: wrapping the real
// `testCmd: { type: "string" },` in a `/* */` block left the suite 9 pass / 0
// fail while `additionalProperties: false` silently dropped the field at
// runtime, breaking the very derivation #142 adds. The `^\s*` anchor those
// pins use rejects a leading `//` and nothing else. Measured, #142 review.
const CODE = stripComments(SOURCE);

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
// the review, never fall back to a guessed default. The reason passed through
// is derive-testcmd.sh's own, which names the derivation step (ADR 0015).
test("no override and no derivation refuses, naming the snapshot agent's reason", () => {
  assert.throws(
    () => resolveTestCmd(undefined, { testCmdError: "derive-testcmd: no Recipe cache at /r/.fleet/recipe.json" }),
    /no test command for this repository — derive-testcmd: no Recipe cache at \/r\/\.fleet\/recipe\.json/,
  );
});

// With no reason from the snapshot agent, the refusal still has to tell its
// reader what to RUN — the derivation step — rather than only that nothing
// was derived: a controller or reviewer reading it has no other pointer.
test("no override, no snapshot at all, and no testCmdError still refuses, naming the derivation step", () => {
  for (const snap of [null, {}]) {
    assert.throws(
      () => resolveTestCmd(undefined, snap),
      /no test command for this repository — the snapshot agent read no Recipe cache; run the Recipe derivation step \(run-team phase 0/,
    );
  }
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
test("runReview actually calls resolveTestCmd once the snapshot is validated", () => {
  assert.match(
    CODE,
    /^\s*const testCmd = resolveTestCmd\(A\.testCmd, snap\);$/m,
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
  const snapshot = between(CODE, "const snap = await agent(", "if (snap) {", "the snapshot agent dispatch");

  assert.match(
    snapshot,
    /~\/\.fleet\/bin\/fleet-run derive-testcmd\.sh \$\{worktree\} test/,
    "the snapshot agent no longer reads the Test entrypoint through derive-testcmd.sh via the Resolver",
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

  // Scoped to `SNAPSHOT_SCHEMA.properties` directly — a real import now,
  // never a second copy of its JSON re-parsed from source text. A field
  // declared ANYWHERE else is undeclared as far as
  // `additionalProperties: false` is concerned.
  for (const field of ["testCmd", "testCmdError"]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SNAPSHOT_SCHEMA.properties, field),
      `${field} is not declared in SNAPSHOT_SCHEMA.properties — additionalProperties:false drops it`,
    );
  }
  // Both stay OUT of `required`: a network or git failure inside
  // derive-testcmd.sh must not abort a snapshot that is otherwise good —
  // resolveTestCmd is what turns a missing derivation into a refusal, not a
  // required-field validation error one layer down. `pathVerified` joins
  // path+head instead (#140): unlike testCmd, its absence must abort. So does
  // `repoVerified` (#1056) — whether the snapshot is a repository holding the
  // reviewed tree decides what a suite run in there is evidence about.
  // `environmentNote`'s strict `=== true` check already guarantees an omitted
  // field reads as UNVERIFIED either way, so the risk `required` guards
  // against is different: omitted from `required`, the snapshot agent could
  // silently drop the field from its structured output — especially under
  // omp's permissive schema-retry-exhaustion mode — and the caller would
  // never find out the measurement was never taken.
  assert.deepEqual(
    SNAPSHOT_SCHEMA.required,
    ["runRoot", "path", "head", "pathVerified", "repoVerified"],
    "required must stay path+head+pathVerified+repoVerified only",
  );
});

// #2315. The prompt that RUNS the command is the shared test run's — every
// specialist used to run it, which made one review up to six full sweeps.
// Bounded at both ends: an unbounded slice runs to EOF, where the specialist
// and refuter prompts could satisfy the assertions below instead.
function testRunPrompt() {
  return between(CODE, "`Run this repository's test command ONCE", '{ label: "test-run"', "the shared test-run prompt");
}

// The prompt is what the test-run agent actually obeys, so the reading rule has
// to be in it. Without this, an agent that guesses a glob still reports
// `tests 0` as a pass — the exact failure the derivation alone does not cover.
test("the test-run prompt hands the command over verbatim and rules 'tests 0' a failure", () => {
  const prompt = testRunPrompt();
  // The command block must INTERPOLATE testCmd, not restate it. A hardcoded
  // copy drifts from the resolved value the moment either one changes, and a
  // caller passing args.testCmd (or the derivation) would be handed the wrong
  // command. Run from the snapshot's root, its output captured to the log
  // every specialist is pointed at.
  assert.match(
    prompt,
    /\{ cd "\$\{snap\.path\}" && \$\{testCmd\}; \} > "\$\{logPath\}" 2>&1; echo "TEST_RUN_EXIT=\$\?"/,
    "the prompt no longer runs the interpolated command verbatim from the snapshot's root into the log",
  );
  // Match the ruling itself, not the phrase `tests 0` — that appears in the
  // surrounding explanation too, so a looser assertion passes with the rule
  // deleted (observed: it did).
  assert.match(prompt, /'tests 0' is a FAILED run/, "the prompt no longer rules a zero-test run a failure");
  // The RULING was pinned and the INSTRUCTION was not, so the sentence telling
  // the agent not to swap the command out could be deleted with this suite
  // green (#143). Everything around it explains why; this is the only clause
  // that actually forbids anything.
  assert.match(
    prompt,
    /Do not substitute a command of your own\./,
    "the prompt no longer forbids substituting a command — only explains why one would be wrong",
  );
  // Once is the whole point of #2315: a retry by the agent is a second full run.
  // The clause, not the phrase — "Run it exactly once, then again when it
  // fails" still contains "Run it exactly once".
  assert.match(
    prompt,
    /Run it exactly once: not again when it fails, and not again when it hits the\s+deadline\./,
    "the prompt no longer forbids running the command a second time",
  );
});

// How the one run is held and read. Each clause is a behavior the agent obeys
// and nothing downstream re-checks: a backgrounded or polled run is the
// unbounded load #2315 measured, a deadline that is far too short reads every
// heavy suite as no counts, a `tail` too short misses the summary, and a 0
// typed in for a count the log never stated turns "no counts" (every dimension
// unrun) into "tests 0" or a clean-looking pass — the distinction
// TEST_RUN_SCHEMA's absent-count rule exists for.
test("the test-run prompt holds the run in the foreground under a deadline, and never invents a count", () => {
  const prompt = testRunPrompt();
  assert.match(prompt, /ONE blocking foreground command — never backgrounded, never polled —/, "the prompt no longer forbids a backgrounded or polled run");
  assert.match(prompt, /with a command deadline of 1800 seconds:/, "the prompt's command deadline changed — size it against a full suite under fleet load");
  assert.match(prompt, /\\`tail -n 40 "\$\{logPath\}"\\`/, "the prompt no longer reads enough of the log's tail to hold a runner's summary");
  assert.match(
    prompt,
    /omit every count and say what happened in \\`error\\`\. Never\s+write 0 for a count the log does not state/,
    "the prompt no longer forbids writing 0 for a count the log does not state",
  );
});

// #143's second correction. The rationale once asserted, present tense and as
// fact about the run being described, that a bare runner "tears down a shared
// container mid-run for every sibling". Measured against this repo:
// this repo's Test entrypoint is a plain `node --test` run and
// `commands/review-and-fix.md` records that this repo has no
// compose file, no `globalSetup`, and no vitest — so no teardown can happen,
// and an agent that checks the reason it was given finds it false.
//
// The rule is still worth carrying, because the review host reviews repos that DO
// have a stack. It has to be stated as a conditional about those repos rather
// than as a fact about this run.
test("the anti-substitution rationale is portable, not a present-tense claim about this run", () => {
  const prompt = testRunPrompt();
  assert.doesNotMatch(
    prompt,
    /tears down a shared container mid-run for every sibling/,
    "the prompt again asserts a container teardown as fact about a run that cannot have one (#143)",
  );
  // The conditional that replaced it, and the half that is NOT conditional: a
  // zero-match glob exits 0 in every repo, so hedging that one would weaken a
  // rule this repo has actually measured (#142).
  assert.match(prompt, /In a repo that has a shared test stack/, "the container rationale is no longer scoped to the repos it can happen in");
  assert.match(prompt, /a guessed glob is\s+worse in every repo/, "the zero-match-glob half is no longer stated as holding everywhere");
});

// The rule #143 widened, now in the one prompt that runs the suite. The
// classifier catches the zero-pass case on its own (`review-core-unrun.test.mjs`),
// but the partial-tree case it CANNOT: `unrunReason` is pure and never learns
// how many tests the whole tree has, so the only guard is the run itself
// starting from the snapshot's root. If this instruction goes, that case has no
// other guard.
test("the test-run prompt rules a no-work run too: zero passes, and a count below the whole tree", () => {
  const prompt = testRunPrompt();
  assert.match(prompt, /0 passes with no failures is\s+everything skipped/, "the prompt no longer rules an all-skipped run a no-work run (#143)");
  assert.match(
    prompt,
    /a count well below what the whole tree reports, which means it ran a\s+PARTIAL copy/,
    "the prompt no longer names a partial-tree run — the case nothing downstream can catch (#143)",
  );
});

// #2315's other half: the specialist prompt must hand the shared run over and
// never the command to run. A specialist prompt that interpolates `testCmd`
// again is six full sweeps per review again.
test("the specialist prompt carries the shared run's note, and never the command to run", () => {
  const prompt = between(CODE, "READ ONLY FROM THE SNAPSHOT", "Scratch files go in", "the specialist prompt");
  assert.doesNotMatch(prompt, /\$\{testCmd\}/, "the specialist prompt hands out testCmd to run again — one full sweep per dimension");
  assert.match(
    prompt,
    /\$\{sharedRunNote\(sharedRun, failureOwner, d\.key\)\}/,
    "the specialist prompt no longer carries the shared run's note",
  );
});
