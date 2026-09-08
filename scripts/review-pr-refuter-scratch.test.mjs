// #496. The `review-pr` workflow's refuter prompt named ONE scratch directory
// per dimension, and carried neither the cd-chaining rule nor the toplevel
// assertion the two hand-dispatch copies gained in PR #495 (#258).
//
// The fan-out under a dimension has TWO axes, and the ticket's prose names both
// — "all n refuters of one dimension are handed the identical path". A
// dimension's findings fan out first, and each finding's lenses fan out inside
// that. A path keyed on the dimension alone is therefore shared by every refuter
// under it, across findings as much as across lenses. Keying on the lens index
// alone closes one axis and leaves the other: finding A's lens 1 and finding B's
// lens 1 are two refuters of the same dimension, which is exactly what the
// ticket's criterion on two refuters of one dimension forbids. Both axes are
// pinned here.
//
// WHY THESE PINS RENDER RATHER THAN GREP. The criterion is stated as a property
// of two RENDERED prompts — they must differ in the scratch path, and not only
// in the lens line. A regex over the source cannot see that: a template that
// interpolates an index still collides if the call site passes a constant. So
// the template literal is lifted out of the source and EVALUATED, and the
// assertions read its output. `review-pr.js` runs a top-level `await
// pipeline(...)` and cannot be imported (measured under #538 — `import()`
// refused for every specifier, `require` undefined inside the Workflow
// sandbox), which is why every pin in this directory lifts rather than imports.
//
// THE CEILING, and the reason a call-site pin is here at all. Rendering supplies
// the indices from THIS file, so a render-only pin stays green if the call site
// stops varying them — the "a lift tests a COPY" failure. The pin over the
// fan-out expressions closes that by asserting they really bind the two names
// the template interpolates.
//
// Two ceilings remain. Extraction takes the FIRST template matching the anchor,
// so a second refuter prompt added elsewhere in the file would go unpinned while
// these stay green — the same first-vs-last hazard measured on this directory's
// function lifts, where the lift reads the first declaration and JS runs the
// last. And nothing here reaches the agent's own obedience: these pins settle
// what a refuter is TOLD, never where it actually writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";

const REPO = join(import.meta.dirname, "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// Extraction runs against CODE, not SOURCE. A block-commented `agent(...)` call
// still contains the whole template, so extracting from raw source would render
// dead text and report every criterion satisfied — the vacuity class
// strip-comments.mjs was written for, measured twice on this exact file.
const CODE = stripComments(SOURCE);

const TEMPLATE_START = "`Try to REFUTE this finding from PR #";
const TEMPLATE_END = "{ label: `verify:";

// The template's free names, in the order `render` binds them. `readRules` and
// `usableDiff` are supplied as stubs: what they return is not under test here,
// and a stub keeps this file from re-deriving the diff-gating rules that
// review-pr-reads.test.mjs already owns.
// `snap.runRoot`, not `scratch`, since #1129: every artefact of one review now
// hangs off a per-run root, so the name the template interpolates changed. That
// root is minted by the snapshot agent's shell and reported back on `snap`, so
// it reaches this template through `snap` rather than as a free name of its own
// — which is why `runScratch` is gone from this list. The binding is what makes
// the "stays under the run's provisioned scratch root" test below mean what it
// says: that root is per RUN now, not per session.
const SCOPE = ["pr", "f", "snap", "stats", "d", "i", "fi", "readRules", "usableDiff"];

function refuterTemplate() {
  const start = CODE.indexOf(TEMPLATE_START);
  assert.notEqual(
    start,
    -1,
    "review-pr.js no longer builds a refuter prompt opening `Try to REFUTE this finding from PR #` — " +
      "either it was renamed, or the whole verify fan-out is commented out. Update this test, or restore the prompt.",
  );
  const end = CODE.indexOf(TEMPLATE_END, start);
  assert.notEqual(end, -1, "the refuter agent() call no longer carries a `verify:` label after its prompt — update this test");
  const slice = CODE.slice(start, end);
  return slice.slice(1, slice.lastIndexOf("`"));
}

const RENDER = new Function(...SCOPE, "return `" + refuterTemplate() + "`");

// One refuter's prompt. `finding` and `lens` are the two fan-out indices; every
// other argument is fixed, so any difference between two renders is caused by
// the axis the caller varied and by nothing else.
function render({ finding = 0, lens = 0, runScratch = "/scr" } = {}) {
  return RENDER(
    7,
    { claim: "the guard fails open", file: "a.js", line: 12, evidence: "line 12 has no else" },
    { path: `${runScratch}/snapshot-abc1234`, head: "abc1234", runRoot: runScratch },
    null,
    { key: "correctness" },
    lens,
    finding,
    () => "READ RULES",
    () => null,
  );
}

const scratchLine = (prompt) => {
  const m = prompt.match(/^Scratch:.*$/m);
  assert.ok(m, "the rendered refuter prompt names no scratch directory at all — a refuter told to write nothing is told nowhere");
  return m[0];
};

// AC-1. Two lenses on ONE finding: the shape the ticket measured, and the one
// #258 fixed on the hand-dispatch path. `Array.from({ length: n }, ...)` is what
// makes these siblings — they are dispatched together, against the same claim,
// and a generic filename from one lands on the other's.
test("two lenses of one finding get different scratch directories", () => {
  const a = scratchLine(render({ finding: 0, lens: 0 }));
  const b = scratchLine(render({ finding: 0, lens: 1 }));
  assert.notEqual(
    a,
    b,
    "both lenses of a finding are handed the same scratch directory — one refuter's mutation matrix lands on its " +
      "sibling's generic filenames, and a false refutation is indistinguishable from a real one",
  );
});

// AC-1, the second axis. The ticket's criterion says "two refuters of the same
// dimension", and a dimension's findings are refuted concurrently — `parallel`
// over `review.findings`, each mapping to its own `parallel` over lenses. Same
// lens number, different finding, is therefore a live sibling pair, and it is
// the pair a lens-index-only fix leaves colliding.
test("the same lens on two findings of one dimension gets different scratch directories", () => {
  const a = scratchLine(render({ finding: 0, lens: 0 }));
  const b = scratchLine(render({ finding: 1, lens: 0 }));
  assert.notEqual(
    a,
    b,
    "two findings of one dimension share a scratch directory at the same lens — the findings fan out concurrently, " +
      "so this is a sibling collision the lens index alone does not close",
  );
});

// AC-1, the mapping rather than the difference. The two pins above assert only
// that two renders DIFFER, and swapping the two indices at the interpolation
// satisfies that exactly as well as the correct mapping — measured on this file
// before this pin existed: the swap kept every test green. The paths do stay
// distinct, so the collision the ticket names is still prevented; what breaks is
// the prompt's own account of its path, which tells the refuter that `f<N>` is
// the finding and `l<N>` the lens. One literal keeps that account true.
test("the scratch path's f segment is the finding index and its l segment the lens index", () => {
  assert.equal(
    scratchLine(render({ finding: 2, lens: 0 })),
    "Scratch: /scr/verify-correctness/f3-l1/",
    "the refuter scratch path no longer maps the finding index to `f<N>` and the lens index to `l<N>` — the roles are " +
      "swapped or the segments renamed, and the prompt's sentence about what its own path means is now false",
  );
});

// AC-1's exact wording: the two prompts must differ in the scratch path "and not
// only in the lens line". Deleting the lens line from both and re-comparing is
// that sentence as an assertion — without it, a prompt whose only per-refuter
// text is `Lens N` would satisfy the two difference pins through the lens line alone.
test("the scratch path is what differs, not merely the lens line", () => {
  const strip = (p) => p.replace(/^Lens .*$/m, "");
  assert.notEqual(
    strip(render({ finding: 0, lens: 0 })),
    strip(render({ finding: 0, lens: 1 })),
    "with the lens line removed the two prompts are byte-identical — the per-refuter namespace is the lens line, " +
      "which names no directory and cannot keep two refuters' files apart",
  );
});

// AC-3. The fix ADDS a level; it does not relocate. A path that became unique by
// moving out of the run's provisioned root would satisfy every difference pin
// while putting refuter writes somewhere the run never provisioned and never cleans.
//
// A prefix alone does not settle "stays under": `/run/scratch/../elsewhere/`
// carries the prefix and resolves outside it, so the escape is asserted
// separately. The template branches on neither index today, which makes the six
// iterations identical; they are kept because the assertion is what would have
// to hold if it ever did branch, and a loop that already covers both axes costs
// nothing to keep and is the wrong thing to be re-adding afterwards.
test("every refuter's scratch path stays under the run's provisioned scratch root", () => {
  for (const finding of [0, 1, 4]) {
    for (const lens of [0, 1]) {
      const line = scratchLine(render({ finding, lens, runScratch: "/run/scratch" }));
      assert.match(
        line,
        /^Scratch: \/run\/scratch\//,
        `the refuter scratch path for finding ${finding} lens ${lens} left the provisioned scratch root — ` +
          "the run provisions that root per run, and a path outside it is neither isolated across runs nor cleaned up",
      );
      assert.doesNotMatch(
        line,
        /\/\.\.(\/|$)/,
        `the refuter scratch path for finding ${finding} lens ${lens} climbs out of the provisioned root with a ` +
          "`..` segment — it keeps the root as a prefix while resolving somewhere the run never provisioned",
      );
    }
  }
});

// AC-2, the write ban — the rule that keeps a refuter out of the checkout, and
// the one the rest of this file's rules exist to make safe. ONE contiguous regex
// for the reason the cd rule below states, applied to the rule that needs it
// most: measured on this file before this pin existed, deleting "and nowhere
// else", deleting the checkout sentence, and splicing an exception between them
// each left every test green. The span runs from "nowhere else" through "never
// write targets" into the `git show` exemption, so the exemption bounds the tail
// instead of leaving it open — the read permission the test below asserts in its
// own right is what closes this rule.
test("the rendered refuter prompt bans writing outside the scratch dir in one unbroken clause", () => {
  assert.match(
    render(),
    /goes\s+there\s+and\s+nowhere\s+else\..{0,200}The\s+checkout\s+and\s+any\s+worktree\s+are\s+never\s+write\s+targets,\s+though\s+`git\s+show`\/`git\s+archive`\s+at\s+a\s+pinned\s+ref\s+read\s+fine\s+anywhere/s,
    "the workflow's refuter prompt no longer confines refuter writes to the scratch directory in one clause — either " +
      "half is gone, or a sentence between them carves an exception into the rule, which is how commit 020d6ea " +
      "reached the checkout during the PR #488 fix-applier run",
  );
});

// AC-2. Same terms as the two hand-dispatch briefs, which
// refuter-scratch-prose.test.mjs pins in run-team/SKILL.md and review-and-fix.md.
// ONE contiguous regex rather than two assertions: an unbounded gap lets a
// spliced sentence carve an exception INTO the rule and stay green — measured on
// that exact pair, and the defect PR #488 fixed in finisher-pin-race-prose.
test("the rendered refuter prompt chains cd into the git command, never semicolon", () => {
  assert.match(
    render(),
    /cd\s+"\$D"\s+&&\s+git\s+….{0,60}never.{0,60}cd\s+"\$D";\s+git\s+…/s,
    "the workflow's refuter prompt carries no cd-chaining rule — a silently failed `cd` leaves the following `git` " +
      "running in the checkout, which is what produced commit 020d6ea during the PR #488 fix-applier run",
  );
});

// Both halves, because they have OPPOSITE expected outcomes: a lone "equals your
// scratch path" guard is unsatisfiable before `git init` — a fresh scratch dir
// has no toplevel and exits 128 — and a guard that cannot pass on the clean path
// gets ignored. Naming a path alone does not catch the observed failure either,
// which was an agent BELIEVING it was already in scratch and being wrong.
test("the rendered refuter prompt requires a toplevel assertion around git init/commit", () => {
  assert.match(
    render(),
    /`git\s+rev-parse\s+--show-toplevel`.{0,60}before\s+`git\s+init`\s+it\s+must\s+NOT\s+resolve\s+to\s+the\s+repository.{0,80}`fatal:\s+not\s+a\s+git\s+repository`.{0,40}is\s+the\s+pass.{0,60}before\s+any\s+`git\s+commit`\s+it\s+must\s+equal\s+your\s+scratch\s+path/s,
    "the workflow's refuter prompt carries no toplevel assertion around a fixture's own git init/commit",
  );
});

// The other direction, and the reason this test exists at all: a prompt that
// GAINS rules can gain one that stops a legitimate verification. A refuter's
// whole job is to run something against the snapshot, and the write ban must not
// read as a ban on reading the PR's own objects — a refuter that cannot do
// either refutes nothing and defaults every finding to refuted.
test("the rendered refuter prompt still orders a real run, and still permits reading at a pinned ref", () => {
  const prompt = render();
  assert.match(
    prompt,
    /RUNNING\s+something\s+—\s+compile\s+it,\s+run\s+the\s+test,\s+apply\s+the\s+mutation\.\s+Do\s+not\s+reason\s+your\s+way\s+to\s+agreement\./,
    "the mandate to verify by RUNNING something is gone — a refuter left to reason its way to a verdict rubber-stamps, " +
      "and the added write rules would have displaced the instruction they exist to make safe",
  );
  assert.match(
    prompt,
    /`git\s+show`\/`git\s+archive`\s+at\s+a\s+pinned\s+ref\s+read\s+fine\s+anywhere/,
    "the write ban now reads as a blanket ban — a refuter that cannot read the PR's own object store cannot verify anything",
  );
});

// The lift's ceiling, closed. Rendering binds `i` and `fi` from this file, so
// every rendering pin stays green if the call site stops varying them — the
// "a lift tests a COPY" failure. These two expressions are what make the
// interpolated names the real fan-out indices.
//
// Both patterns are anchored to a line start that no `/` precedes, for two
// separate reasons. `stripComments` blanks whole-line comments only, so an
// unanchored match reads a real regression back out of a TRAILING comment on the
// line that carries it — one syntactic form is not the class. And the leading
// `\s*` the anchor would normally take is wrong here: the findings fan-out is
// chained onto an expression, so its `.map(` never begins its own line. Optional
// whitespace inside the argument lists keeps a reformat of the same call green.
test("the verify fan-out really binds the two indices the prompt interpolates", () => {
  assert.match(
    CODE,
    /^[^\n/]*\.map\(\(f,\s*fi\)\s*=>/m,
    "the findings fan-out no longer binds a per-finding index — the prompt may still interpolate `fi`, but it would " +
      "resolve to something the fan-out does not vary, and every finding of a dimension would collide again",
  );
  assert.match(
    CODE,
    /^[^\n/]*Array\.from\(\{\s*length:\s*n\s*\},\s*\(_,\s*i\)\s*=>/m,
    "the lens fan-out no longer binds a per-lens index — same failure on the other axis",
  );
});
