import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./support/strip-comments.mjs";
import { Pin } from "./support/prose-pin.mjs";
import { runReview, SNAPSHOT_SCHEMA, TEST_RUN_SCHEMA } from "../plugin/scripts/review-core.mjs";
import { ARGS, SNAP, parallel, pipeline, review, scriptedHost } from "./support/review-host-fixture.mjs";

// The review host used to default `testCmd` to a literal string naming THIS
// repo's own test path — silent green everywhere else, since `worktree` is a
// caller-supplied argument and a glob matching nothing exits 0 reporting
// `tests 0` (#142). Every caller now passes the Test entrypoint it read off
// the repo under review's Recipe cache, and the review refuses without one
// (#4046): the snapshot no longer reads the Test entrypoint at all. See
// derive-testcmd.test.mjs for the reader's own coverage.
//
// This file covers what remains review-core.mjs's own responsibility: the
// refusal of a review with no test command, the snapshot agent's prompt and
// schema carrying the Install step but no Test entrypoint, and the shared
// test-run prompt (#2315) handing testCmd over verbatim with the 'tests 0'
// rule — the one prompt that runs it, since no specialist runs the full suite
// any more.
const REPO = join(import.meta.dirname, "..", "plugin");
const SOURCE = readFileSync(join(REPO, "scripts", "review-core.mjs"), "utf8");

// Every pin below runs against CODE, not SOURCE — the same policy, and now the
// same stripper, as `review-core-reads.test.mjs`. Written against raw source,
// this file's schema-declaration pin was VACUOUS: wrapping the real
// `testCmd: { type: "string" },` in a `/* */` block left the suite 9 pass / 0
// fail while `additionalProperties: false` silently dropped the field at
// runtime, breaking the very derivation #142 adds. The `^\s*` anchor those
// pins use rejects a leading `//` and nothing else. Measured, #142 review.
const CODE = stripComments(SOURCE);

const SNAPSHOT_ONLY = { snapshot: [SNAP], "review:correctness": [review([])] };

// #4046: nothing derives a test command any more, so a review handed none has
// nothing to run. It refuses on its own terms, naming `testCmd`, before the
// snapshot agent or anything else is dispatched — a refusal after the
// snapshot would spend a cut on a review that could never run its suite.
test("runReview with testCmd absent, empty or blank refuses before any agent is dispatched, naming testCmd", async () => {
  for (const testCmd of [undefined, null, "", "   ", 42]) {
    const run = scriptedHost(SNAPSHOT_ONLY);
    await assert.rejects(
      runReview({ ...run.host, pipeline, parallel }, { ...ARGS, testCmd }),
      /^Error: review-pr: args\.testCmd is required/,
      `testCmd ${JSON.stringify(testCmd)} was not refused naming testCmd`,
    );
    assert.deepEqual(run.labels, [], `testCmd ${JSON.stringify(testCmd)} dispatched ${run.labels.join(", ")} before refusing`);
  }
});

// The accept direction: a review handed a command runs exactly that command,
// whatever a snapshot report might carry beside it.
test("runReview with a testCmd runs exactly that command in the shared run", async () => {
  const run = scriptedHost({ ...SNAPSHOT_ONLY, snapshot: [{ ...SNAP, testCmd: "node --test elsewhere" }] });
  await runReview({ ...run.host, pipeline, parallel }, { ...ARGS, testCmd: "npm test -- --ci" });
  assert.equal(run.calls["test-run"], 1, "the shared run was not dispatched once");
  assert.ok(run.prompts["test-run"][0].includes("suite-slot.mjs 'npm test -- --ci'; }"), "the shared run does not run the command the caller passed");
  assert.ok(!run.prompts["test-run"][0].includes("elsewhere"), "the shared run ran a command the snapshot report carried");
});

// A hardcoded default anywhere in this file is the exact regression #142
// fixes — `A.testCmd || "<literal>"` is the shape it used to take.
test("no hardcoded testCmd default remains", () => {
  assert.doesNotMatch(CODE, /A\.testCmd\s*\|\|\s*"/, "a literal testCmd default reappeared — the review runs the command its caller passes");
});

// The snapshot agent's return schema carries the Install step's facts the same
// way diffPath/diffLines/prHead were added: `additionalProperties: false` drops
// an undeclared field silently, so BOTH the prompt asking for it and the
// schema declaring it have to be pinned, or the feature disconnects in one
// token exactly like `review-core-reads.test.mjs`'s "the snapshot agent asks for
// the diff facts AND declares them in its schema" records happening to the
// diff facts. The Test entrypoint is no longer one of them (#4046): the caller
// passes it, so the snapshot neither reads it nor declares it.
test("the snapshot agent reads the Install step at origin/main AND the schema declares its facts, and no Test entrypoint is read", () => {
  const snapshot = Pin.of(CODE, "CODE").between("const snap = await agent(", "if (snap) {", "the snapshot agent dispatch").text;

  assert.doesNotMatch(snapshot, /derive-testcmd\.sh \$\{worktree\} test/, "the snapshot agent reads the Test entrypoint again — every caller passes testCmd, so nothing would use it");
  assert.doesNotMatch(snapshot, /testCmd/, "the snapshot prompt asks for a test command again");
  // The command also has to RUN where the specialists are told to run it.
  // `git archive` carries tracked files only, so a tree whose suite needs an
  // installed dependency exits non-zero in a bare snapshot while passing in
  // the worktree its Recipe was proven in. The Install step is read through
  // the same reader, off the review worktree (the snapshot holds no Recipe
  // cache), against `origin/main` — the tree the Recipe was proven on, so a
  // PR that breaks the step's path runs it and fails it rather than reading
  // as an invalid cache (#4046) — and run in `$SNAP`, from its root.
  assert.match(
    snapshot,
    /INSTALL=\$\(~\/\.omp\/plugins\/node_modules\/@feigi\/fleet-ctl\/scripts\/fleet-run derive-testcmd\.sh \$\{worktree\} install --at origin\/main\)/,
    "the snapshot agent no longer reads the Install step through derive-testcmd.sh via the Resolver, off the worktree that holds the cache, at origin/main",
  );
  assert.match(
    snapshot,
    /\( cd "\$SNAP" && env -u CI sh -c "\$INSTALL" \)/,
    "the Install step no longer runs from the snapshot's own root with CI unset — a suite needing an installed dependency cannot run in it",
  );
  // These names live inside a template literal, so each backtick is a
  // BACKSLASH-backtick in the source text — `\\?` matches it either way, the
  // same idiom `review-core-reads.test.mjs` uses for diffPath/prHead/diffLines.
  const B = "\\\\?`";
  assert.match(
    snapshot,
    new RegExp(`Report\\s+${B}installCmd${B}\\s+=\\s+the\\s+SNAPSHOT_INSTALL_STEP\\s+value\\s+and\\s+${B}installExit${B}\\s+=\\s+the\\s+SNAPSHOT_INSTALL_EXIT\\s+value`),
    "installCmd/installExit are not bound to the lines the block prints — the caller cannot tell a failed install from a skipped one",
  );
  assert.match(
    snapshot,
    new RegExp(`SNAPSHOT_INSTALL_UNREAD\\s+instead,\\s+omit\\s+both\\s+and\\s+report\\s+${B}installError${B}`),
    "installError is not bound to an unreadable Install step",
  );
  assert.match(
    snapshot,
    new RegExp(`Report\\s+${B}untracked${B}\\s+=\\s+every\\s+SNAPSHOT_UNTRACKED=\\s+value`),
    "untracked is not bound to the status lines the block prints after the Install step",
  );
  assert.match(
    snapshot,
    new RegExp(`report\\s+${B}untrackedCount${B}\\s+=\\s+the\\s+SNAPSHOT_UNTRACKED_COUNT\\s+value`),
    "untrackedCount is not bound to the count the block prints — a status past the printed twenty reads as only those twenty",
  );
  assert.match(
    snapshot,
    new RegExp(`SNAPSHOT_STATUS_FAILED,\\s+report\\s+${B}statusError${B}`),
    "statusError is not bound to the line the block prints when it cannot read the status — an unreadable status reads as an empty one",
  );

  // Scoped to `SNAPSHOT_SCHEMA.properties` directly — a real import now,
  // never a second copy of its JSON re-parsed from source text. A field
  // declared ANYWHERE else is undeclared as far as
  // `additionalProperties: false` is concerned.
  for (const field of ["installCmd", "installExit", "installError", "untracked", "untrackedCount", "statusError"]) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(SNAPSHOT_SCHEMA.properties, field),
      `${field} is not declared in SNAPSHOT_SCHEMA.properties — additionalProperties:false drops it`,
    );
  }
  for (const field of ["testCmd", "testCmdError"]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(SNAPSHOT_SCHEMA.properties, field), `${field} is declared in SNAPSHOT_SCHEMA.properties again — nothing reads it`);
  }
  // The Install step's facts stay OUT of `required`: a network or git failure
  // inside derive-testcmd.sh must not abort a snapshot that is otherwise good
  // — installReason is what turns an unread step into a skipped suite, not a
  // required-field validation error one layer down. `pathVerified` joins
  // path+head instead (#140): its absence must abort. So does
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
  return Pin.of(CODE, "CODE").between("`Run this repository's test command ONCE", "{ label: `test-run${forPr}`", "the shared test-run prompt").text;
}

// The prompt is what the test-run agent actually obeys, so the reading rule has
// to be in it. Without this, an agent that guesses a glob still reports
// `tests 0` as a pass — the exact failure the derivation alone does not cover.
test("the test-run prompt hands the command over verbatim and rules 'tests 0' a failure", () => {
  const prompt = testRunPrompt();
  // The command block must INTERPOLATE testCmd, not restate it. A hardcoded
  // copy drifts from the passed value the moment either one changes, and a
  // caller passing args.testCmd would be handed the wrong
  // command. Run from the snapshot's root, its output captured to the log
  // every specialist is pointed at, and through the suite-slot wrapper — the
  // only thing between the command and the host-wide bound.
  assert.match(
    prompt,
    /\{ cd "\$\{snap\.path\}" && \$\{slotted\(testCmd\)\}; \} > "\$\{logPath\}" 2>&1; echo "TEST_RUN_EXIT=\$\?"/,
    "the prompt no longer runs the interpolated, slot-wrapped command from the snapshot's root into the log",
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
  assert.match(prompt, /with a command deadline of 3600 seconds:/, "the prompt's command deadline changed — it must cover the slot wait cap and the run's own budget");
  assert.match(prompt, /\\`tail -n 40 "\$\{logPath\}"\\`/, "the prompt no longer reads enough of the log's tail to hold a runner's summary");
  assert.match(
    prompt,
    /omit every count and say what happened in \\`error\\`\. Never\s+write 0 for a count the log does not state/,
    "the prompt no longer forbids writing 0 for a count the log does not state",
  );
});

// The wrapper's wait and its two outputs reach the test-run agent only through
// this prompt, and nothing downstream re-reads them: an agent not told to copy
// `SUITE_SLOT_WAIT_MS` leaves `slotWaitMs` with no source, and one not told that
// exit 75 launched nothing reports a held slot as a crashed suite.
test("the test-run prompt tells the agent where slotWaitMs comes from and what exit 75 is", () => {
  const prompt = testRunPrompt();
  assert.match(prompt, /\\`SUITE_SLOT_WAIT_MS=<n>\\` line to the log; report \\`slotWaitMs\\` = that number,\s+copied as printed/, "the prompt no longer sources slotWaitMs from the wrapper's own line");
  assert.match(prompt, /TEST_RUN_EXIT is 75 and the log holds\s+\\`suite-slot: no slot after <n>s\\`\. That is not a test result/, "the prompt no longer says what exit 75 is");
  assert.match(prompt, /copy that line into \\`error\\`, and do not run\s+the command again/, "the prompt no longer carries the line testRunReason reads the wait cap from, or no longer forbids a re-run");
});

// #2879: with no field of its own, vitest's `N expected fail` token could only
// be folded into `fail`, so a tree carrying one deliberate `it.fails` read as a
// failing suite. The field is optional like every other count: a runner that
// prints no such token reports none.
test("the test-run prompt routes an expected fail into its own optional field, never into fail", () => {
  const prompt = testRunPrompt();
  assert.match(prompt, /\\`fail\\`,\s+\\`expectedFail\\`, \\`cancelled\\`/, "the prompt no longer asks for the expected-fail count");
  // The example names two ecosystems' tokens, side by side: one runner named
  // alone reads as the runner the fleet assumes a consumer uses.
  assert.match(
    prompt,
    /\(vitest \\`expected fail\\`, pytest \\`xfailed\\`\) goes in \\`expectedFail\\`, never in\s+\\`fail\\`/,
    "the prompt no longer keeps an expected fail out of `fail`, or no longer names it from two ecosystems",
  );
  assert.equal(TEST_RUN_SCHEMA.properties.expectedFail?.type, "integer", "the test-run schema has no integer `expectedFail` field");
  assert.match(
    TEST_RUN_SCHEMA.properties.expectedFail.description,
    /\(vitest `expected fail`, pytest `xfailed`\)/,
    "the schema's expectedFail description no longer names an expected fail from two ecosystems",
  );
  assert.equal(TEST_RUN_SCHEMA.required, undefined, "a required count would force a 0 the log never stated");
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
// but the partial-tree case it CANNOT: `suiteVerdictOf` is pure and never learns
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
  const prompt = Pin.of(CODE, "CODE").between("READ ONLY FROM THE SNAPSHOT", "Scratch files go in", "the specialist prompt").text;
  assert.doesNotMatch(prompt, /\$\{testCmd\}/, "the specialist prompt hands out testCmd to run again — one full sweep per dimension");
  assert.match(
    prompt,
    /\$\{sharedRunNote\(sharedRun, failureOwner, d\.key\)\}/,
    "the specialist prompt no longer carries the shared run's note",
  );
});
