// #1673. #1433 put the inherited-cwd rule into review-core.js's two dispatch
// prompts and left the Claude harness's twin — workflows/review-pr.js's own
// hardcoded Review/Verify `agent()` calls — carrying none of it. The measured
// defect is review-core-cwd-isolation.test.mjs's to state: three PRs reviewed
// back-to-back from one omp `eval` cell left FOUR files modified in the
// checkout that cell was standing in, through relative paths, with nothing in
// any payload saying so. Nothing about that failure is omp-specific. A Claude
// review specialist is dispatched with the SAME inherited cwd — no dispatch
// primitive on either harness takes a per-call cwd, which is why the remedy is
// prompt prose on both (review-eval.mjs's header holds that determination) —
// so the harness that was never told is the harness that never reports.
//
// WHY A SECOND FILE RATHER THAN A BRANCH IN THE FIRST. review-core.js is an
// ordinary module and review-pr.js cannot be imported at all (the Workflow
// sandbox forbids `import` — see prose-pin.mjs's own note), so the two are
// reached differently: the omp copy's pins go on to run `runReview` against a
// fake host, which has no counterpart here. What this file adds is the half
// neither harness's own suite can hold: every span below is asserted against
// BOTH rendered prompts from ONE constant, so the two copies are pinned
// word-for-word AGAINST EACH OTHER. A reword on either side reds, which is the
// asymmetry #1673 reports — #1433 edited one harness and the suite stayed
// green.
//
// THE ONE TOKEN THAT LEGITIMATELY DIFFERS, and why it is not smuggled into a
// loose regex. review-core.js's refuter states the cwd clause as the tail of
// its scratch sentence ("…goes there and nowhere else, and your shell does not
// start there: …"). review-pr.js cannot: its scratch sentence is followed by a
// sibling-collision sentence and a write-ban that
// review-pr-refuter-scratch.test.mjs pins as ONE unbroken clause, so a splice
// there reds that file. The Claude copy therefore opens the same clause as its
// own sentence, one sentence later — `Your` for `and your`. That difference is
// pinned explicitly, per harness, below: the shared span is one constant, and
// each harness's own lead-in is asserted immediately in front of it, so
// neither copy can quietly lose the sentence the clause hangs off.
//
// WHY THESE PINS RENDER RATHER THAN GREP, and why the slice is the pin: the
// reasons review-core-cwd-isolation.test.mjs and
// review-pr-specialist-scratch.test.mjs both state. The rules live inside
// template literals whose backticks are written escaped (`` \` ``), so a
// source-text pin passes just as happily on a prompt showing the agent a
// literal `\`; and both prompts in each file carry the same wording, so a pin
// matched against a whole file would be satisfied by either of them — which is
// the defect shape this ticket reports one dispatch at a time. Each prompt is
// extracted by its own `agent()` call's anchors through prompt-renderer.mjs
// and rendered, so its sibling is outside it by construction. Extraction runs
// over comment-stripped source, so a block-commented dispatch reds at
// extraction rather than rendering as live text.
//
// THE CEILING, same as every sibling pin's: nothing here reaches the agent's
// own obedience. These pins settle what a dispatch is TOLD and what the schema
// can carry back — never where a specialist actually writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { phrase } from "./prose-pin.mjs";
import { promptRenderer, workflowCode } from "./prompt-renderer.mjs";

const CLAUDE = "workflows/review-pr.js";
const OMP = "scripts/review-core.js";
const SNAP = { path: "/scr/run-1/snapshot-abc1234", head: "abc1234", runRoot: "/scr/run-1" };

// `readRules`/`usableDiff`/`environmentNote` are stubs for the sibling pins'
// reason — what they return is owned by review-pr-reads.test.mjs, and binding
// them keeps a render that stops passing one throwing a ReferenceError instead
// of dropping a paragraph silently. Every other argument is fixed: these pins
// are about what the prompts SAY, not about how they vary.
const STUBS = [() => "READ RULES", () => null, () => "TEST ENVIRONMENT"];

const specialistOf = (file) =>
  promptRenderer({
    file,
    start: "`Review PR #${pr} (branch ${branch}) for: ",
    end: "label: `review:",
    scope: ["pr", "branch", "d", "snap", "worktree", "stats", "testCmd", "readRules", "usableDiff", "environmentNote"],
    what: `${file}'s specialist prompt (opening \`Review PR #\${pr} (branch \${branch}) for: \`, labelled \`review:\`)`,
  })(7, "feature/x", { key: "correctness", prompt: "does it do what it says" }, SNAP, "/repo/.worktrees/7-x", null, "node --test", ...STUBS);

const refuterOf = (file) =>
  promptRenderer({
    file,
    start: "`Try to REFUTE this finding from PR #",
    end: "{ label: `verify:",
    scope: ["pr", "f", "snap", "stats", "d", "i", "fi", "readRules", "usableDiff", "environmentNote"],
    what: `${file}'s refuter prompt (opening \`Try to REFUTE this finding from PR #\`, labelled \`verify:\`)`,
  })(7, { claim: "the guard fails open", file: "a.js", line: 12, evidence: "line 12 has no else" }, SNAP, null, { key: "correctness" }, 0, 0, ...STUBS);

// The four rendered prompts, keyed by the harness whose file they came out of.
// `claude` is the copy #1673 exists to pin; `omp` is the source of truth every
// span is lifted from, and asserting against it too is what makes each
// constant a word-for-word comparison rather than a transcription nobody
// rechecks.
const specialist = { claude: specialistOf(CLAUDE), omp: specialistOf(OMP) };
const refuter = { claude: refuterOf(CLAUDE), omp: refuterOf(OMP) };

const both = (prompts) => [
  [`${CLAUDE} (Claude)`, prompts.claude],
  [`${OMP} (omp)`, prompts.omp],
];

// The plain `[dispatch, prompts]` pairing, reused by every loop below that
// needs no third per-dispatch value — the loops that DO need one (the
// lead-in text, the schema name) keep their own three-tuple list rather than
// bolting a third element onto this shared shape.
const DISPATCHES = [
  ["specialist", specialist],
  ["refuter", refuter],
];

// --- Part 1: the inherited cwd is named, as a tree not to write to ---------
// ONE contiguous span per prompt, never two assertions and never a `.{0,N}`
// gap, for review-core-cwd-isolation.test.mjs's reason: the three clauses have
// to arrive together or the rule is not the rule. "carries no working
// directory of its own" alone is a fact with no instruction; naming the
// controller's checkout alone reads as context; and "a relative path lands
// THERE" is the only clause that says what to do differently.
const SPECIALIST_CWD = phrase(
  "Your shell starts in NEITHER of those directories, and what it does start in is a tree you must not write to: this dispatch carries no working directory of its own, so you begin wherever the controller's own review cell is standing — its checkout, the tree it reads instruments.sh, ci-state.mjs and every gate decision out of. A relative path in any command lands THERE, not in the snapshot and not in your scratch dir.",
);

test("both harnesses' specialist prompts name the cwd they inherit, in the same words", () => {
  for (const [name, prompt] of both(specialist)) {
    assert.match(
      prompt,
      SPECIALIST_CWD,
      `${name}'s specialist prompt no longer names the directory it starts in as a tree not to write to, or the two harnesses no longer word it identically — a specialist that does not know it inherited the controller's checkout writes into it through a relative path, which is how three reviews left four files modified there (#1433/#1673)`,
    );
  }
});

// The refuter's clause, and the one place the two copies legitimately differ:
// the shared span is asserted from one constant against both, and each
// harness's own lead-in is asserted immediately in front of it, so neither can
// keep the clause while losing the sentence that gives "there" an antecedent.
const REFUTER_CWD =
  "this dispatch carries no working directory of its own, so you begin wherever the controller's own review cell is standing — its checkout, the tree it reads every gate decision out of — and a relative path in any command lands THERE.";

test("both harnesses' refuter prompts name the cwd they inherit, in the same words", () => {
  for (const [name, prompt] of both(refuter)) {
    assert.match(
      prompt,
      phrase(REFUTER_CWD),
      `${name}'s refuter prompt no longer names the directory it starts in, or the two harnesses no longer word it identically — a refuter applies MUTATIONS, so a relative path there is the worst case of the defect (#1433/#1673)`,
    );
  }
});

test("each refuter's cwd clause hangs off that harness's own scratch sentence, not on nothing", () => {
  assert.match(
    refuter.claude,
    phrase(`for a \`/tmp\` scratch dir on macOS. Your shell does not start there: ${REFUTER_CWD}`),
    "workflows/review-pr.js's refuter no longer opens the cwd clause directly after the toplevel-assertion sentence review-pr-refuter-scratch.test.mjs pins — a rewording or a splice between them leaves the cwd clause hanging off nothing, the same defect the omp-side pin below catches for its own preceding sentence",
  );
  assert.match(
    refuter.omp,
    phrase(`goes there and nowhere else, and your shell does not start there: ${REFUTER_CWD}`),
    "scripts/review-core.js's refuter no longer carries the cwd clause on the tail of its scratch sentence — the shape review-pr.js deliberately does NOT copy, so this is the pin that keeps that difference a known one rather than drift",
  );
});

// --- Part 2: `pwd` first, and the inherited directory is a no-run zone -----
// Both halves in one span. `pwd` with no consequence attached is a print
// statement, and "a no-run zone" naming no directory is unenforceable — the
// failure recorded here is an agent that BELIEVED it was somewhere else, which
// only a printed path settles.
const PWD_FIRST = phrase("Run `pwd` as your FIRST command and keep the path it prints; that directory is a no-run zone from then on");

for (const [dispatch, prompts] of DISPATCHES) {
  test(`both harnesses' ${dispatch} prompts require \`pwd\` first and call that directory a no-run zone`, () => {
    for (const [name, prompt] of both(prompts)) {
      assert.match(
        prompt,
        PWD_FIRST,
        `${name}'s ${dispatch} prompt no longer fixes which directory it inherited before anything else — the audit below has no path to name, and every later rule that says "that directory" names nothing (#1673)`,
      );
    }
  });
}

// --- Part 3: the positive self-check, into a field the schema carries ------
// The audit command and the report contract are separate spans because they
// fail separately: a bare `--porcelain` is a silently WRONG audit (a
// `status.showUntrackedFiles=no` config makes it print nothing on a tree
// holding new files, which reads as clean), while a missing report contract is
// an audit nobody can read.
//
// The span STARTS at the lead-in, not at the command, and that is measured
// rather than stylistic: replacing the specialist's "Then audit the directory
// that first `pwd` printed, before you return:" with "Then, optionally:" left
// an earlier draft of this file green at 13/13. The command alone is an audit
// bound to no directory and demanded at no time — both of the things that make
// it a check rather than a suggestion live in that sentence, so the sentence is
// inside the pin. The gap is `\s+` throughout (the prose is hard-wrapped at
// ~78 columns), never a free-text `.{0,N}` span, so a spliced exception reds
// rather than fitting between the halves.
const AUDIT_COMMAND = " `git -C <that path> status --porcelain -uall` — the explicit untracked mode, never bare `--porcelain`, which a `status.showUntrackedFiles=no` config silences into a false clean.";

// Each dispatch's own lead-in — identical across harnesses, different between
// the two dispatches, because the refuter's lead-in follows its own `pwd`
// sentence directly and the specialist's does not.
for (const [dispatch, prompts, leadIn] of [
  ["specialist", specialist, "Then audit the directory that first `pwd` printed, before you return:"],
  ["refuter", refuter, "Then audit that directory before you return:"],
]) {
  test(`both harnesses' ${dispatch} prompts audit the inherited directory before returning, with the explicit untracked mode`, () => {
    for (const [name, prompt] of both(prompts)) {
      assert.match(
        prompt,
        phrase(leadIn + AUDIT_COMMAND),
        `${name}'s ${dispatch} prompt no longer audits the directory it started in before returning, or dropped \`-uall\` — a bare \`--porcelain\` under \`status.showUntrackedFiles=no\` reports a tree full of new files as clean, and an audit tied to no directory and no moment is a suggestion (#1673)`,
      );
    }
  });
}

// The report contract, and the half a prose pin usually cannot reach: the
// field each prompt names has to be one its OWN schema declares. review-pr.js
// cannot be imported, so both schemas are lifted from its source the way
// review-core-parity.test.mjs lifts them. Both are `additionalProperties:
// false`, so a rule pointing at any other name is inert — the agent's audit is
// dropped in validation and the prompt still reads correct. The field name is
// EXTRACTED from the rendered prompt rather than transcribed, so the pin fails
// in either direction: the prompt renaming the field, or the schema losing it.
// Gaps are `\s+`, never literal spaces — this prose is hard-wrapped at ~78
// columns, so every one of them may be a newline.
//
// The two prompts phrase this two different ways ("Report the result in" /
// "Report it in") — one alternation between them, not two independent
// optionals, which would also admit the dead combination neither prompt writes
// ("Report the result it in").
const REPORT_FIELD = /Report\s+(?:the\s+result|it)\s+in\s+`(\w+)`\s+as\s+one\s+line\s+beginning\s+`CWD-AUDIT:`/;

const CODE = workflowCode(CLAUDE);
const liftSchema = (name) => {
  const src = CODE.match(new RegExp(`^const ${name} = \\{[\\s\\S]*?^\\};$`, "m"));
  assert.ok(src, `workflows/review-pr.js no longer declares a module-scope ${name} — update this test`);
  return new Function(`${src[0]}\nreturn ${name};`)();
};

for (const [dispatch, prompts, schemaName] of [
  ["specialist", specialist, "FINDINGS_SCHEMA"],
  ["refuter", refuter, "VERDICT_SCHEMA"],
]) {
  test(`workflows/review-pr.js's ${dispatch} prompt reports CWD-AUDIT into a field its own ${schemaName} declares, and the same field the omp copy names`, () => {
    const schema = liftSchema(schemaName);
    const named = prompts.claude.match(REPORT_FIELD);
    assert.ok(
      named,
      `workflows/review-pr.js's ${dispatch} prompt no longer names a report field for the CWD-AUDIT line — an audit the agent has nowhere to put is an audit the caller never sees (#1673)`,
    );
    assert.equal(
      schema.additionalProperties,
      false,
      `workflows/review-pr.js's ${schemaName} no longer refuses undeclared fields — this pin's premise (a wrongly-named field is DROPPED, not passed through) no longer holds; re-derive it`,
    );
    assert.ok(
      Object.hasOwn(schema.properties, named[1]),
      `workflows/review-pr.js's ${dispatch} prompt asks for the audit in \`${named[1]}\`, which ${schemaName} does not declare — \`additionalProperties: false\` drops it in validation and the prompt still reads correct`,
    );
    const namedOmp = prompts.omp.match(REPORT_FIELD);
    assert.ok(
      namedOmp,
      `scripts/review-core.js's ${dispatch} prompt no longer names a report field for the CWD-AUDIT line — an audit the agent has nowhere to put is an audit the caller never sees (#1673)`,
    );
    assert.equal(
      named[1],
      namedOmp[1],
      `the two harnesses' ${dispatch} prompts now report the audit into DIFFERENT fields — a controller reading one harness's payload finds nothing in the other's (#1673)`,
    );
  });
}

// Every state the audit line can take, spelled in the prompt that must emit
// it. A state a prompt cannot spell is a state it will not report — and
// "clean" is the one that matters most, since an audit reported only when it
// finds something is indistinguishable from one never run.
for (const [dispatch, prompts] of DISPATCHES) {
  test(`both harnesses' ${dispatch} prompts spell every state of the CWD-AUDIT line, and require it on a clean run`, () => {
    for (const [name, prompt] of both(prompts)) {
      for (const state of ["clean", "dirty", "unrepo"]) {
        assert.match(
          prompt,
          phrase(`\`CWD-AUDIT: ${state} <path>`),
          `${name}'s ${dispatch} prompt no longer spells the \`${state}\` form of the audit line (#1673)`,
        );
      }
      assert.match(
        prompt,
        phrase("every run, clean or not"),
        `${name}'s ${dispatch} prompt no longer demands the audit on a clean run — an omitted line reads exactly like a check never run, which is how "four files dirty" was found by chance rather than by a report (#1433/#1673)`,
      );
    }
  });
}

// One marker, spelled once, or a controller grepping a review's payload for it
// finds half the reports. Checked per prompt: a capture group around a fixed
// literal can only ever capture that same literal, so comparing one prompt's
// capture against another's could never fail as long as both matched at all.
for (const [dispatch, prompts] of DISPATCHES) {
  test(`both harnesses' ${dispatch} prompts name the CWD-AUDIT marker as a code span`, () => {
    for (const [name, prompt] of both(prompts)) {
      assert.match(
        prompt,
        /`CWD-AUDIT:`/,
        `${name}'s ${dispatch} prompt no longer names the CWD-AUDIT marker as a code span — a reader cannot tell the literal from the prose around it`,
      );
    }
  });
}
