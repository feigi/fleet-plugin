// #393. A closing keyword immediately before an issue reference in a PR body
// creates a closing link, so narrative prose about what a pass already did is
// indistinguishable from a deliberate `Closes #N`. Two triage-authored PRs
// shipped one, and both were caught only because someone happened to check
// `closingIssuesReferences`.
//
// `docs/agents/issue-tracker.md` carries both remedies the ticket rules on —
// the guidance that prevents the common case and the check that catches a body
// nobody wrote to the guidance. This pins the parts of that section that decide
// BEHAVIOUR, so a later edit cannot leave the section looking complete with a
// rule silently gone or reversed.
//
// SHAPE, and the reason every pin below is one exact contiguous span rather
// than two matches on the same slice: N independent matches pin N facts and
// never the text between them, so a clause spliced into the join reverses a
// rule while every token an assertion wants is still present. The rules here
// are all joins — a mechanism bound to its fix, a surface bound to its
// exclusion — so each is asserted whole. `phrase()` rebuilds the span with
// `\s+` between words, which is what keeps an exact-span pin from reddening on
// a reflow; "a reflowed section still matches" below is what holds that open.
//
// THE CEILING: these prove a rule is PRESENT and unspliced. They cannot prove
// it is not negated by a sentence added elsewhere in the section, and they say
// nothing about whether the rule is correct.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const TRACKER = readFileSync(join(REPO, "docs", "agents", "issue-tracker.md"), "utf8");

// Bounded at both ends. Run to EOF and the wayfinding section below supplies
// enough `gh`/issue vocabulary to satisfy a loose assertion with this section
// deleted outright; the heading that follows is the boundary, and `between()`
// reddens loudly if either anchor goes stale rather than widening the slice.
//
// Flattened, not raw: the source is hard-wrapped, so a pinned span breaks
// across lines at a width nobody should have to preserve. Every assertion below
// runs against the flattened text and is therefore reflow-safe.
const section = (text = TRACKER) =>
  between(text, '## When a skill says "compose a PR body"', "\n## When a skill says", "docs/agents/issue-tracker.md")
    .split(/\s+/)
    .join(" ");

// Positive control. An equality-free suite of `match` assertions is exactly the
// shape that passes on a slice that has degenerated to its own heading, and a
// stale-but-still-findable anchor pair is how it would get there.
test("the section slice is more than its own heading", () => {
  assert.ok(section().length > 200, "the slice collapsed to (near) its heading — the extractor is broken, not the docs");
});

test("the adjacency rule names its fix in the same breath", () => {
  // The mechanism alone is not actionable and the fix alone is not derivable:
  // an agent told only that adjacency links, or only to write `closed issue
  // #N`, cannot generalize to the reference forms the rule actually covers.
  // Asserted as one span so a spliced exception ("unless the issue is already
  // closed") reddens rather than sliding between two matches.
  assert.match(
    section(),
    phrase("immediately before an issue reference creates a closing link, and the fix is to insert a word: write `closed issue #219`, or name the issue without the `#`"),
  );
});

test("the keyword list stays whole and stays bound to the mechanism", () => {
  // The list is operationally load-bearing and reads like a tidy-up target: an
  // agent narrating with a keyword that has silently dropped off it gets no
  // signal that adjacency will auto-link. Pinned as one span with the clause it
  // qualifies, so a list orphaned from its rule reddens too.
  assert.match(
    section(),
    phrase("A closing keyword — `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, `resolved` — immediately before an issue reference"),
  );
});

test("the preventive rule names what to do with every OTHER mention", () => {
  // The cheapest of the two remedies, and the only one that prevents rather
  // than detects. "Write one deliberate `Closes #N`" alone is not the rule —
  // it is silent on the narrative mentions that caused both instances, so the
  // deliberate keyword and the treatment of the rest are asserted as one span.
  assert.match(
    section(),
    phrase("Write one deliberate `Closes #N` and give every other issue mention a word in front of it"),
  );
});

test("the section records that one keyword does not chain across a list", () => {
  // Without it, an author who fixes the reference they noticed leaves the rest
  // of the list linked and reads the partial result as arbitrary rather than as
  // the documented behaviour.
  assert.match(section(), phrase("One keyword before a list links exactly the first reference, never the rest"));
});

test("the section says to re-query the closing references and act on a mismatch", () => {
  // "Re-query" without "compare against intent" is a command with no verdict,
  // and both without "surface it" is a verdict nobody sees — this is the
  // remedy that actually caught both historical instances, so the whole chain
  // is pinned as one span.
  assert.match(
    section(),
    phrase("re-query its closing references and compare them against what you meant to close, surfacing a mismatch rather than accepting it silently"),
  );
});

test("the lazy-recompute caveat sits with the check it qualifies", () => {
  // The check produces a false clean read without it, which is worse than no
  // check: it converts "unverified" into "verified fine".
  assert.match(
    section(),
    phrase("recomputes closing references lazily, so a query issued immediately after the create can read falsely clean — re-query after a pause"),
  );
});

test("the section refuses a keyword regex as evidence on its own", () => {
  // The false-POSITIVE half. Everything else here guards against a missed
  // link; this guards against reporting one that GitHub never made, measured
  // on a body whose keyword sits in a code span.
  assert.match(
    section(),
    phrase("Compare a regex hit against the linked set before calling it a defect"),
  );
});

test("the section binds the rule to PR bodies and commit messages and excludes issue comments", () => {
  // A MAPPING: surface in, surface out. Pinning "PR bodies and commit
  // messages" and "issue comment" as two matches leaves a swap — comments
  // bound, bodies exempted — green with every token still present, so the
  // sentence that carries the mapping is asserted whole.
  assert.match(
    section(),
    phrase("Closing keywords bind in PR bodies and commit messages only. An issue comment may write the adjacency freely — it creates no link"),
  );
});

test("a reflowed section still matches", () => {
  // The ACCEPT direction, and the only thing here proving the exact-span pins
  // discriminate content rather than layout. A pin that reddened on a rewrap
  // would be loosened by the next person who reflowed a paragraph, and a
  // loosened span pin is the vacuous keyword pin this shape exists to avoid.
  const rewrapped = TRACKER.replace("creates a closing link, and the fix", "creates a closing link,\nand the fix");
  assert.notEqual(rewrapped, TRACKER, "the rewrap fixture no longer matches the section — update it");
  assert.match(section(rewrapped), phrase("creates a closing link, and the fix is to insert a word"));
});

// #1118. The section above is reached only by a skill that says "compose a PR
// body", and the step that actually opens a PR — `next-ticket` step 7, which
// every implementer runs — never said it. The ruling put the rule in the step
// itself instead of a citation, so it is pinned where the PR is opened. Same
// anchors as force-with-lease-reason-prose.test.mjs's step-7 slice.
const NEXT_TICKET = readFileSync(join(REPO, "plugin", "skills", "next-ticket", "SKILL.md"), "utf8");
const step7 = (text = NEXT_TICKET) =>
  between(text, "## 7. When the superpowers path reports done", "## Red flags", "next-ticket/SKILL.md step 7");

test("next-ticket step 7 says one keyword per intended close, and that several such closes are fine", () => {
  // The per-issue half and the multi-close example are one span: a rewrite to
  // "only one closing keyword per body" is the plausible over-correction, and
  // it forbids the deliberate `Closes #971, closes #864` this sentence allows.
  assert.match(
    step7(),
    phrase("Write one `Closes #M` per issue you mean to close, so `Closes #971, closes #864` closes both"),
    "step 7 lost the one-keyword-per-intended-close rule, or narrowed it so a deliberate multi-issue close reads as wrong",
  );
});

test("next-ticket step 7 says what to do with every OTHER issue mention", () => {
  assert.match(
    step7(),
    phrase("give every other issue mention a word in front of it — `closed issue #M`, or the issue named without the `#`"),
    "step 7 no longer tells the author to put a word in front of issue mentions it does not mean to close",
  );
});

test("next-ticket step 7 says a keyword before a list links only its first reference", () => {
  assert.match(
    step7(),
    phrase("A keyword before a list links only the first reference in that list, never the rest"),
    "step 7 no longer says one keyword does not chain across a list",
  );
});

test("the step-7 pins survive a reflow of the rule", () => {
  // The ACCEPT direction for the step-7 pins, as the section's reflow test is
  // for the ones above.
  const rewrapped = NEXT_TICKET.replace("per issue you mean to close, so", "per issue\nyou mean to close,\nso").replace(
    "links only the first reference",
    "links only\nthe first reference",
  );
  assert.notEqual(rewrapped, NEXT_TICKET, "the rewrap fixture no longer matches step 7 — update it");
  const s = step7(rewrapped);
  assert.match(s, phrase("Write one `Closes #M` per issue you mean to close, so `Closes #971, closes #864` closes both"));
  assert.match(s, phrase("A keyword before a list links only the first reference in that list, never the rest"));
});
