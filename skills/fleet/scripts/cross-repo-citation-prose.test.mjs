import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// #35. A fleet reference doc cited its whole evidence base as "PR #574" while
// this repo's PRs stop in the thirties, so the number reads as local — to a
// human and to an agent. Not a broken link (a repo's own markdown files link
// nothing); a reader defect, which is why counts-not-numbers was the only
// workaround the file had. The convention that closes it is host-split, and
// both halves need pinning: the rule where the controller relays it, the
// applied instance where the foreign evidence sits.
const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");
const CORRECTIONS = readFileSync(
  join(REPO, "skills", "fleet", "skills", "run-team", "references", "correction-tickets.md"),
  "utf8",
);

// Slice-scoped, not whole-file: SKILL.md is 1200+ lines and a bare presence
// check anywhere in it stays green when the text lands somewhere its reader
// never reaches (measured before in this repo — member-prompt-prose.test.mjs
// #172). The correction-ticket rule block is the one the controller copies
// into an implementer's prompt.
function slice(text, startAnchor, endAnchor, what, { endsFile = false } = {}) {
  const at = text.indexOf(startAnchor);
  assert.notEqual(at, -1, `${what} start anchor ('${startAnchor}') moved — update this test`);
  const end = text.indexOf(endAnchor, at);
  // `endsFile` sections run to EOF until someone appends a section after them,
  // so a missing end anchor is the normal state there, not a moved anchor.
  if (end === -1 && endsFile) return text.slice(at);
  assert.notEqual(end, -1, `${what} end anchor ('${endAnchor}') moved — update this test`);
  return text.slice(at, end);
}

// Markdown hard-wraps at ~80 columns, so a phrase splits across lines. Phrase
// matches need the wrap invisible.
const flat = (s) => s.replace(/\s+/g, " ");

const correctionRuleBlock = () =>
  flat(
    slice(
      RUN_TEAM,
      "**Correction tickets ship new wrong claims",
      "#### Fallback: hand-dispatched reviewer member",
      "the correction-ticket rule block",
    ),
  );

const conventionSection = () =>
  flat(
    slice(CORRECTIONS, "## Citing evidence from another repo's run", "\n## ", "the citation convention", {
      endsFile: true,
    }),
  );

const secondRunSection = () =>
  flat(slice(CORRECTIONS, "## Second mechanism", "## The clause-by-clause duty", "the second-run evidence"));

test("the cross-repo citation rule reaches the implementer, in the rule block the controller relays", () => {
  const block = correctionRuleBlock();
  assert.match(
    block,
    /another repo/i,
    "the correction-ticket rule block no longer says anything about evidence from another repo — an implementer relayed only this block writes a bare `#N` for foreign evidence again",
  );
  assert.match(
    block,
    /owner\/repo#N/,
    "the github.com half of the citation rule is gone from the block the controller relays",
  );
  assert.match(
    block,
    /GHE/,
    "the non-github.com half is gone — the rule now reads as if `owner/repo#N` fits every source, which is the form that resolves to nothing for a GHE-hosted one",
  );
});

test("the convention splits by host, and both branches name what to write", () => {
  const section = conventionSection();
  assert.match(
    section,
    /github\.com.*owner\/repo#N/,
    "the github.com branch no longer prescribes the qualified `owner/repo#N` form",
  );
  assert.match(
    section,
    /(GHE|GitLab|internal).*naming (the )?host and repo/i,
    "the non-github.com branch no longer prescribes prose naming the host and the repo",
  );
  assert.match(
    section,
    /cannot be settled from this repo/,
    "the non-github.com branch no longer requires marking the evidence unsettleable from here — a reader is left believing a settling command exists for it",
  );
});

test("the convention carves out this repo's own references instead of banning bare `#N`", () => {
  // The REFUSE half. Stated as "never write a bare `#N`" the rule condemns
  // every local reference in the repo, this file's own `PR #32` included.
  assert.match(
    conventionSection(),
    /own issues and PRs stay bare `#N`/,
    "the convention no longer says local references stay bare — read as a blanket ban it sends a reader qualifying hundreds of correct local `#N`s",
  );
});

test("the second-run evidence names its source repo, its host, and that it cannot be settled here", () => {
  const section = secondRunSection();
  assert.match(
    section,
    /CoCo\/agent-brain/,
    "the second-run evidence no longer identifies its source repo — 'a different repo' gives provenance without identity, so a reader cannot reach the evidence at all",
  );
  assert.match(
    section,
    /bmw\.ghe\.com/,
    "the host is gone — without it a reader takes `CoCo/agent-brain` for a github.com repo and gets a 404",
  );
  assert.match(
    section,
    /none of it can be settled from this repo/,
    "the unsettleable marker is gone, and the ordinals this section carries ('4th of 5', '3rd') read as claims someone could re-check against this tree",
  );
});

test("the ordinal-verification mechanism is named as behavior, not in the source repo's test vocabulary", () => {
  const section = secondRunSection();
  assert.doesNotMatch(
    section,
    /\bexpect\b/,
    "the mechanism is scoped as foreign vocabulary again (`git grep 'expect(' HEAD` → zero hits here; this repo is `node:test` + `assert.*`), which invites a reader to discard a lesson that applies here unchanged",
  );
  assert.match(
    section,
    /failing assertion aborts the rest of its test/,
    "the aborting-assertion behavior is no longer named generically — with it gone the ordinal trap reads as a quirk of someone else's runner",
  );
});

test("local references in the same file are still bare — the convention did not get applied to them", () => {
  // ACCEPT side. `PR #32` is this repo's own, MERGED, and correct as written;
  // an over-applied convention rewrites it to `feigi/claude-config#32`.
  assert.match(
    CORRECTIONS,
    /PR #32 measured/,
    "the local `PR #32` reference was rewritten — the convention covers foreign evidence only, and qualifying a local reference is the false positive it must not produce",
  );
  assert.doesNotMatch(
    CORRECTIONS,
    /feigi\/claude-config#/,
    "a local reference got the cross-repo qualified form; bare `#N` is correct and required for this repo's own issues and PRs",
  );
});
