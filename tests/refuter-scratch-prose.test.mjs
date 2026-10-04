// #258. The dictated refuter prompt orders filesystem writes — "compile it, run
// the test, apply the mutation" — and named no location. Three measured
// instances: a refuter's mutation matrix collided with a sibling's in a shared
// scratchpad; a probe built a throwaway git repo at the maintainer's checkout
// root while its own report claimed a different path; and a fixture's `cd`
// silently failed, leaving the following `git` commands running in the live
// checkout, where they committed an uncommitted settings.json edit.
//
// A fourth measured instance is deliberately NOT cited above: fix-appliers on
// different PRs colliding on `unv1`/`unv2`/`unv7`/`unv11`, because finding ids
// restart at 1 every review. The clause pinned below binds only the REFUTER's
// own writes — it opens "Everything you write" — and #258 is refuter-shaped, so
// a fix-applier's own scratch path is out of scope. Citing that failure as
// motivation here would claim coverage these pins do not have.
//
// The instruction is quoted VERBATIM in two documents — run-team/SKILL.md's
// fix-applier dispatch block, and review-and-fix.md step 2 — and neither carried
// a scratch clause. A fix added to only one is the one that does not reach
// whichever path a given caller takes, so both slices are pinned here.
//
// THE CEILING, same as fleet-tick-prose.test.mjs and issue-tracker-prose.test.mjs:
// these are PRESENCE pins over a bounded slice. Every one is a single regex —
// one contiguous span, or `.{0,40}` joins between anchors — so text spliced
// INSIDE a pinned clause reddens them (measured both ways). What they still
// cannot catch is a WHOLE NEW sentence appended AFTER the clause that carves out
// an exception: nothing pins the clause's neighbourhood. A reflow of the same
// words (line wraps, `**bold**` moved) stays green by design — the words are
// what is pinned, not their layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");

// The run-team/SKILL.md copy sits inside a nested `> > ` blockquote, so a hard
// wrap can land INSIDE a phrase with the quote gutter, not whitespace, at the
// break — `\s+` does not span it, `>` is not whitespace. Strip the gutter per
// line and rejoin with a single space, which restores exactly the original
// inter-word space at a wrap point (markdown only ever wraps AT one). Harmless
// on review-and-fix.md's copy, which carries no `>` prefix to strip.
function stripQuoteGutter(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/^(>\s?)+/, ""))
    .join(" ");
}

const runTeamPrompt = () =>
  stripQuoteGutter(
    between(RUN_TEAM, "Try to REFUTE this finding", "Survives → apply it, with one hold", "run-team/SKILL.md"),
  );
const reviewAndFixPrompt = () =>
  stripQuoteGutter(
    between(
      REVIEW_AND_FIX,
      "Try to REFUTE this finding",
      "That last clause is the whole mechanism",
      "review-and-fix.md",
    ),
  );

for (const [name, getPrompt] of [
  ["run-team/SKILL.md", runTeamPrompt],
  ["review-and-fix.md", reviewAndFixPrompt],
]) {
  // `\s+` between every word, never a literal space — a wrap point can land
  // INSIDE a pinned phrase, not just between clauses, and dropped this whole
  // group to 4/8 the first time it was measured (see the mutation-test note
  // at the top of this file). The words are pinned, not the exact bytes.
  test(`${name}: refuter prompt names a two-level scratch path and forbids checkout writes`, () => {
    const prompt = getPrompt();
    // ONE contiguous span, not two independent `assert.match` calls. Two
    // regexes with no bound on the gap between them let a spliced sentence
    // carve an exception INTO the write-ban and stay 8/8 green — measured on
    // this exact pair, and the same defect PR #488 fixed in
    // finisher-pin-race-prose.test.mjs. The real gap here is `; the `, so
    // pinning it costs nothing and closes the splice.
    assert.match(
      prompt,
      /`<scratch>\/pr<N>\/<finding>\/`\s+and\s+nowhere\s+else;\s+the\s+checkout\s+and\s+any\s+worktree\s+are\s+never\s+write\s+targets/,
      "the scratch-path clause is broken — either the two-level path is gone (a refuter falls back to a generic name and collides with a sibling, or with a fix-applier on another PR, since finding ids restart at 1 every review), or the write ban is gone, or a sentence was spliced BETWEEN them carving out an exception",
    );
  });

  test(`${name}: refuter prompt still permits reading the PR at a pinned ref`, () => {
    assert.match(
      getPrompt(),
      /`git\s+show`\/`git\s+archive`\s+at\s+a\s+pinned\s+ref\s+read\s+fine\s+anywhere/,
      "the write ban reads as a blanket ban — a refuter that cannot read the PR's own object store cannot verify anything",
    );
  });

  test(`${name}: refuter prompt chains cd into the git command, never semicolon`, () => {
    assert.match(
      getPrompt(),
      /cd\s+"\$D"\s+&&\s+git\s+….{0,40}never.{0,40}cd\s+"\$D";\s+git\s+…/s,
      'no cd-chaining rule — a fixture\'s silently failed `cd` can leave a `git` command running in the checkout, the actual failure during the PR #488 run',
    );
  });

  test(`${name}: refuter prompt requires a toplevel assertion around git init/commit, including the realpath remedy for macOS's /private/tmp symlink`, () => {
    assert.match(
      getPrompt(),
      /`git\s+rev-parse\s+--show-toplevel`.{0,40}before\s+`git\s+init`\s+it\s+must\s+NOT\s+resolve\s+to\s+the\s+repository.{0,40}`fatal:\s+not\s+a\s+git\s+repository`.{0,40}is\s+the\s+pass.{0,40}before\s+any\s+`git\s+commit`\s+it\s+must\s+resolve\s+to\s+your\s+scratch\s+path.{0,80}compare\s+resolved\s+forms.{0,60}realpath/s,
      "no toplevel assertion around git init/commit, or the realpath remedy for macOS's /private/tmp symlink is gone — the observed failure is the agent BELIEVING it is already in scratch and being wrong, which naming a path alone does not catch. Both halves are pinned because they have OPPOSITE expected outcomes: a single `resolves to your scratch path` guard is unsatisfiable before `git init` (a fresh scratch dir has no toplevel and exits 128), and a guard that cannot pass on the clean path gets ignored",
    );
  });
}

// #1150. The clause above names `<scratch>/pr<N>/<finding>/` inside the
// instruction the REFUTER reads, which left the refuter to resolve it — a
// child deriving its own path. The ruling is that the parent assigns it: the
// fix-applier resolves the placeholder to an absolute path (its own `pr<N>`,
// the finding's id) and writes that path into the refuter's prompt. That
// clause sits in the lead-in the FIX-APPLIER reads, ahead of the quoted
// instruction, so it is sliced from the dispatch line to the instruction's
// opening words — both copies, one phrase, for this file's two-copies reason.
const SUBSTITUTION =
  "with one substitution: resolve `<scratch>/pr<N>/<finding>/` in it to an absolute path under your own run root — `mktemp -d` once per round for `<scratch>/pr<N>/fix-XXXXXXXX/`, never bare `pr<N>`, since finding ids restart at 1 each round too — and write that absolute path into the refuter's prompt in its place; a refuter never derives its own path";
for (const [name, getLeadIn] of [
  ["run-team/SKILL.md", () => stripQuoteGutter(between(RUN_TEAM, "In scope → dispatch ONE refuter", "Try to REFUTE this finding", "run-team/SKILL.md"))],
  ["review-and-fix.md", () => between(REVIEW_AND_FIX, "In scope → dispatch one refuter", "Try to REFUTE this finding", "review-and-fix.md")],
]) {
  test(`${name}: the fix-applier resolves the refuter's scratch path to an absolute one and writes it into the refuter's prompt`, () => {
    assert.match(
      getLeadIn(),
      phrase(SUBSTITUTION),
      "the fix-applier is no longer told to resolve `<scratch>/pr<N>/<finding>/` to an absolute path of its own and write it into the refuter's prompt — the refuter is back to deriving its own path from a placeholder",
    );
  });
}
