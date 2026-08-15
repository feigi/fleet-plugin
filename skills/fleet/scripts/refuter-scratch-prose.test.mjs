// #258. The dictated refuter prompt orders filesystem writes — "compile it, run
// the test, apply the mutation" — and named no location. Four measured
// instances: a refuter's mutation matrix collided with a sibling's in a shared
// scratchpad; a fix-applier found `unv1`/`unv2`/`unv7`/`unv11` already occupied
// by fix-appliers on OTHER PRs, because finding ids restart at 1 every review; a
// probe built a throwaway git repo at the maintainer's checkout root while its
// own report claimed a different path; and a fixture's `cd` silently failed,
// leaving the following `git` commands running in the live checkout, where they
// committed an uncommitted settings.json edit.
//
// The instruction is quoted VERBATIM in two documents — run-team/SKILL.md's
// fix-applier dispatch block, and review-and-fix.md step 2 — and neither carried
// a scratch clause. A fix added to only one is the one that does not reach
// whichever path a given caller takes, so both slices are pinned here.
//
// THE CEILING, same as fleet-tick-prose.test.mjs and issue-tracker-prose.test.mjs:
// these are PRESENCE pins over a bounded slice. They prove the clause is THERE;
// they cannot prove it survives a sentence added beside it that carves out an
// exception, and a reflow of the same words (line wraps, `**bold**` moved) stays
// green by design — the words are what is pinned, not their layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "skills", "fleet", "commands", "review-and-fix.md"), "utf8");

// Bound at BOTH ends — see review-pr-reads.test.mjs:276-282 for why an
// unbounded end lets a later, unrelated occurrence of the same phrase satisfy
// the assertion with the real clause deleted.
function between(text, from, to, what) {
  const at = text.indexOf(from);
  assert.notEqual(at, -1, `${what} no longer contains "${from}" — update this test`);
  const end = text.indexOf(to, at + from.length);
  assert.notEqual(end, -1, `${what} no longer contains "${to}" after "${from}" — update this test`);
  return text.slice(at, end);
}

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
    assert.match(
      prompt,
      /`<scratch>\/pr<N>\/<finding>\/`\s+and\s+nowhere\s+else/,
      "no two-level scratch path — a refuter falls back to a generic name and collides with a sibling, or with a fix-applier on another PR (finding ids restart at 1 every review)",
    );
    assert.match(
      prompt,
      /checkout\s+and\s+any\s+worktree\s+are\s+never\s+write\s+targets/,
      "nothing forbids writing outside scratch — a refuter can still land a write in the checkout, as measured",
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
      'no cd-chaining rule — a fixture\'s silently failed `cd` can leave a `git` command running in the checkout, the actual PR #488 failure',
    );
  });

  test(`${name}: refuter prompt requires a toplevel assertion before git init/commit`, () => {
    assert.match(
      getPrompt(),
      /git\s+rev-parse\s+--show-toplevel.{0,40}equals\s+your\s+scratch\s+path,\s+not\s+the\s+repository/s,
      "no toplevel assertion before git init/commit — the observed failure is the agent BELIEVING it is already in scratch and being wrong, which naming a path alone does not catch",
    );
  });
}
