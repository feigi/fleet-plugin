// #1550. PR #1084 (implemented as #1530) added two directory-safety rules to
// the `review-pr` WORKFLOW's specialist prompt — chain the directory change
// into the command, and bracket a fixture's own git with `git rev-parse
// --show-toplevel` — mirroring what PR #1082 had already added to that same
// file's REFUTER prompt (review-pr-refuter-scratch.test.mjs pins that copy).
// scripts/review-core.mjs carries a second, host-neutral (omp) copy of the same
// specialist dispatch prompt and carried neither rule, while ordering the same
// kind of work: "Run any mutation or probe work inside your own copy of the
// snapshot."
//
// Naming the write area is not the same rule and does not close either failure
// mode. The specialist prompt already said scratch files go in its own
// directory "and nowhere else", and both measured failures happen with that
// sentence obeyed as written: a `cd` that silently fails leaves the following
// `;`-separated `git` running in whatever directory the agent was already in —
// the incident review-pr-refuter-scratch.test.mjs records as commit 020d6ea
// reaching the checkout during the PR #488 fix-applier run — and an agent that
// BELIEVES it is already in its scratch copy and is wrong runs `git init` /
// `git commit` against the repository. A rule about where writes SHOULD go
// does not detect either.
//
// INLINED, NOT SHARED, same as workflows/review-pr.js's copy and for the same
// reason: #496's brief rules the shared-source route out — "the drift hazard
// is real and is its own ticket, not this one" — and review-core.mjs's own
// harness is host-neutral (omp) rather than a Claude-hosted workflow script,
// so it cannot import review-pr.js either. That drift hazard is exactly what
// this pin exists to convert into a red: it failed to fire once already, which
// is why this ticket exists at all.
//
// WHY THESE PINS RENDER RATHER THAN GREP. Two reasons, and the second is the
// one a source-text pin cannot reach. The rules live inside a template
// literal, so their backticks are written escaped (`` \` ``); a pin written
// against the source has to tolerate that backslash, and then it passes just
// as happily on a prompt that shows the specialist a literal `\` instead of a
// code span. Rendering settles what the agent actually reads. And a bounded
// slice of the SOURCE would still be satisfied by dead text — the vacuity
// class strip-comments.mjs exists for — whereas a commented-out prompt does
// not render at all.
//
// THE SLICE IS THE PIN. Each rule appears more than once in this file (the
// verify/refuter prompt below carries its own, older copy), so every regex
// here would be satisfied by the refuter's copy alone if it were matched
// against the whole file — which is exactly the defect this ticket reports,
// so a pin that could pass on the refuter's copy would have passed before the
// fix. The extraction is bounded at both ends by the specialist `agent()`
// call's own template and its `review:` label, so the refuter prompt is
// outside it by construction. Both directions were measured: reverting the two
// rules out of the specialist prompt reds all three tests here with the
// refuter's copy untouched.
//
// THE CEILING, same as review-pr-refuter-scratch.test.mjs's: nothing here
// reaches the agent's own obedience. These pins settle what a specialist is
// TOLD, never where it actually writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { between } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "scripts", "review-core.mjs"), "utf8");
const CODE = stripComments(SOURCE);

const TEMPLATE_START = "`Review PR #${pr} (branch ${branch}) for: ";
const TEMPLATE_END = "label: `review:";

// The template's free names, in the order `render` binds them. `readRules`,
// `usableDiff` and `environmentNote` are stubs: what they return is not under
// test here, and binding them keeps a render that stops passing one from
// dropping a paragraph silently — it throws a ReferenceError instead.
const SCOPE = ["pr", "branch", "d", "snap", "worktree", "stats", "testCmd", "readRules", "usableDiff", "environmentNote"];

// `between` owns the bounded-slice extraction (and both failure messages);
// only the backtick trim below is specific to a template literal and stays
// here.
const SLICE = between(
  CODE,
  TEMPLATE_START,
  TEMPLATE_END,
  "review-core.mjs's specialist prompt (opening `Review PR #${pr} (branch ${branch}) for: `, labelled `review:`)",
);

const RENDER = new Function(...SCOPE, "return `" + SLICE.slice(1, SLICE.lastIndexOf("`")) + "`");

// One specialist's prompt. Every argument is fixed: these pins are about what
// the prompt SAYS, not about how it varies, so nothing here needs to.
const render = () =>
  RENDER(
    7,
    "feature/x",
    { key: "correctness", prompt: "does it do what it says" },
    { path: "/scr/run-1/snapshot-abc1234", head: "abc1234", runRoot: "/scr/run-1" },
    "/repo/.worktrees/7-x",
    null,
    "node --test",
    () => "READ RULES",
    () => null,
    () => "TEST ENVIRONMENT",
  );

// The first of the two rules, in the prompt that was missing it. ONE
// contiguous regex rather than two assertions, for the reason
// refuter-scratch-prose.test.mjs states about the same wording: an unbounded
// gap lets a spliced sentence carve an exception INTO the rule and stay green.
// Both gaps are the literal punctuation the rendered prompt carries around
// "never" ("…`, " before it, a line break plus backtick after) rather than a
// free-text `.{0,N}` span — mutation-tested: an exception clause spliced into
// either gap (e.g. "never except during setup steps") reds this assertion.
//
// Both spellings are required, and the negative one is what carries the rule —
// `cd "$D" && git …` alone reads as a suggestion, and the observed failure is
// an agent writing the other form.
test("the rendered specialist prompt chains cd into the git command, never semicolon", () => {
  assert.match(
    render(),
    /cd\s+"\$D"\s+&&\s+git\s+…`,\s+never\s+`cd\s+"\$D";\s+git\s+…/s,
    "review-core.mjs's specialist prompt carries no cd-chaining rule — a silently failed `cd` leaves the following `git` " +
      "running in the checkout, which is what produced commit 020d6ea during the PR #488 fix-applier run (#1550)",
  );
});

// The second rule. Both halves, because they have OPPOSITE expected outcomes:
// a lone "resolves to your scratch path" guard is unsatisfiable before `git
// init` — a fresh scratch dir has no toplevel and exits 128 — and a guard that
// cannot pass on the clean path gets ignored. Naming a path alone does not
// catch the observed failure either, which was an agent BELIEVING it was
// already in scratch and being wrong. Gaps are the literal prose between the
// four clauses, typed out rather than left as a free-text `.{0,N}` span —
// mutation-tested: a short exception clause spliced into any of the first,
// third, or fourth gaps (e.g. "except in CI runners," right after the
// leading `:`, or "except during rebase," right after "not a failure;")
// reds this assertion; the same splices pass a `.{0,N}`-gapped version of
// this regex undetected.
//
// The realpath tail is part of the pin, not decoration on it, and carries the
// same typed gaps for the same reason. PR #1567 added that remedy to all four
// copies of this rule but the pin to only the refuter's two, so the clause sat
// unpinned in both specialist prompts: deleting it from both (measured, #1570)
// left this file and its review-pr sibling at 6/6 and the four refuter/prose
// pins at 41/41, all green. It is also the half that makes the rule
// satisfiable in the OTHER direction — `--show-toplevel` answers
// `/private/tmp/…` for a `/tmp` scratch dir on macOS, so a raw string compare
// reports a mismatch on the clean path, and a guard that cannot pass there
// gets ignored exactly as a lone `git init` half would.
//
// Both directions on the tail itself: an exception clause spliced into its
// leading gap ("…your scratch path, except in CI runners — compare resolved
// forms…") reds this assertion, where the `.{0,80}`-gapped spelling in
// review-pr-specialist-scratch.test.mjs lets it through; rewrapping the clause
// to one line and to a narrower column stays green, since every gap here is
// `\s+` (all measured).
test("the rendered specialist prompt requires a toplevel assertion around git init/commit, including the realpath remedy for macOS's /private/tmp symlink", () => {
  assert.match(
    render(),
    /`git\s+rev-parse\s+--show-toplevel`:\s+before\s+`git\s+init`\s+it\s+must\s+NOT\s+resolve\s+to\s+the\s+repository,\s+and\s+a\s+fresh\s+scratch\s+dir's\s+`fatal:\s+not\s+a\s+git\s+repository`\s+\(exit\s+128\)\s+is\s+the\s+pass,\s+not\s+a\s+failure;\s+before\s+any\s+`git\s+commit`\s+it\s+must\s+resolve\s+to\s+your\s+scratch\s+path\s+—\s+compare\s+resolved\s+forms\s+\(`realpath`\),\s+since\s+`--show-toplevel`\s+can\s+report\s+`\/private\/tmp\/…`\s+for\s+a\s+`\/tmp`\s+scratch\s+dir\s+on\s+macOS/s,
    "review-core.mjs's specialist prompt carries no toplevel assertion around a fixture's own git init/commit, or " +
      "dropped the realpath remedy for macOS's /private vs /tmp symlink — an agent that wrongly believes it is " +
      "already in its scratch copy runs `git init`/`git commit` against the repository, and a raw compare against " +
      "`--show-toplevel` reads a `/private/tmp` answer for a `/tmp` scratch dir as a mismatch on the clean path (#1550, #1570)",
  );
});

// The other direction, and the reason a prose pin on an ADDED rule needs one: a
// prompt that gains rules can displace the instructions those rules exist to
// make safe, and both of the added rules are written in terms of the
// specialist's own scratch area — "your scratch path" names nothing once the
// directory sentence goes, and a rule about a fixture's git is inert if the
// prompt no longer orders mutation work in a copy of its own.
//
// The scratch sentence and the first rule are asserted as one bounded span,
// with the gap between them typed as `\s+` — the rendered prompt carries
// exactly one space there, never a free-text `.{0,N}` — so a sentence spliced
// between them (mutation-tested: "Except for git fixtures, which may live
// anywhere.") reds this assertion instead of leaving both halves present and
// passing.
test("the added rules still sit on a prompt that names a write area and orders work in its own copy", () => {
  const prompt = render();
  assert.match(
    prompt,
    /Run any mutation or probe work inside your own copy of the snapshot\./,
    "review-core.mjs's specialist is no longer told to do mutation or probe work in a copy of its own — the two " +
      "directory rules now guard work the prompt never scopes to a copy at all",
  );
  assert.match(
    prompt,
    /Scratch\s+files\s+go\s+in\s+\/scr\/run-1\/correctness\/\s+and\s+nowhere\s+else\.\s+Chain\s+the\s+directory\s+change\s+into\s+the\s+command/s,
    "review-core.mjs's specialist prompt no longer names the scratch directory immediately before the cd rule — " +
      "either the write area is gone, leaving 'your scratch path' naming nothing, or a sentence between them carves " +
      "an exception into it",
  );
});
