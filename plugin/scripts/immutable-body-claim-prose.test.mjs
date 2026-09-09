// #402. Two commits on #399 both closed `Verified: … 86/86 across both test
// files that read` this file, a file set the tree does not bear out, and a
// pushed commit body cannot be edited. The rules beside this block all scope to
// prose the DIFF restates, so none of them reached the body that ships the
// diff. This file pins the rule that closes that gap.
//
// Measured against `origin/main` before this file existed: no test read the
// words `commit body` in `run-team/SKILL.md` at all, so the whole rule could be
// deleted with the suite green.
//
// SHAPE, and what to preserve when editing these tests. The slice runs from the
// anti-count rule that precedes this one to the `#### Fallback` heading that
// follows it — bounded at both ends, because a positive regex over the whole
// correction-discipline block is vacuous: every word of this rule is somewhere
// in it, so the assertion passes with the rule deleted. `cross-repo-citation-
// prose.test.mjs` pins the same block for the citation convention and takes it
// whole; that slice is large enough that presence checks inside it prove
// nothing about this rule.
//
// Each fragment is bound to the content beside it rather than asserted alone.
// The failure that matters here is not deletion — it is a narrowing back to
// what the ticket's TITLE said (measurement counts under a `Verified:` header),
// which the brief ruled out because it would miss both attribution errors. So
// the claim types are pinned as one ordered span, and the shipping/motivating
// pair as one span too: two presence checks on "ships" and "motivated" stay
// green through the swap that tells a member to settle its claims at the commit
// that prompted the work.
//
// THE CEILING, the same one `dispatch-block-pins-prose.test.mjs` records and
// #1002 tracks: these are pins on text being PRESENT and adjacent. A sentence
// APPENDED after a pinned one that carves an exception out of it — "a claim
// already settled earlier in the branch needs no re-run" — touches no pinned
// fragment and stays green. Measured, not assumed: that mutant was run against
// this file and passed. Do not read a green run here as "no carve-out was
// added to this rule".
//
// That appended-clause half is the KNOWN ceiling, and it is what #1002 records
// and measures. A second half is not: a MEANING-CHANGING clause inserted
// MID-GAP — between the two anchors of one ordered span, touching no pinned
// fragment — is absorbed wherever that span's `.{0,N}?` still has headroom, and
// the suite stays green. The tolerance exists so a meaning-PRESERVING copy-edit
// does not red the pin, and an insertion that changes the rule's meaning inside
// the same gap is a different case no assertion here sees.
//
// Measured on this file, not assumed, and the property is per-gap headroom
// rather than one every span here has. Re-derive by inserting the literal into
// `run-team/SKILL.md` and running this file: `unless it names a public source, `
// in the ranking span's gap stayed green, `nobody relies on ` in the
// `Verified:` span stayed green, and `, for correction tickets only` in the
// hand-over span stayed green — while `, unless re-running it is impractical`
// in the endings span pushed past that gap's cap and RED it.
//
// Tightening the gaps is not the fix, and NOT for the reason that first comes to
// mind. Reflow is not what a tight gap costs: `flatten` collapses whitespace
// before matching, so re-wrapping the source leaves the gap's flattened length
// identical. Measured — the endings gap narrowed to its exact content (84
// chars, zero headroom) stayed GREEN through a hard re-wrap of the whole rule
// at 42 columns. What a tight gap costs is word-level copy-editing: the same
// zero-headroom gap RED on inserting the single word `it` into "not one to
// assert bare". That is a meaning-preserving edit, and a pin that reds on one
// is a pin the next person to touch this prose weakens or deletes.
// The mechanism has to change, which is #1002's own conclusion.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// `**` emphasis is stripped and whitespace collapsed before matching, so a
// pinned span may cross a bold boundary or a hard wrap and neither an emphasis
// move nor a reflow is a failure. `phrase()` alone cannot do the first: it
// escapes `*` as a regex metacharacter, which makes the exact position of a
// `**` seam literal test surface, and a false red on a meaning-preserving
// copy-edit is how a pin gets deleted by the next person to touch the prose.
//
// Only `**` is stripped, deliberately. Single `*` is a live character in this
// slice — `*instead of*` italicises the word that carries the `Verified:`
// rationale — so stripping it would corrupt the text rather than normalize it.
// The `>` gutter strip is inert here (this rule is not a blockquote) and kept
// so that quoting it into a member prompt does not red every pin below.
const flatten = (s) =>
  s
    .split("\n")
    .map((l) => l.replace(/^>\s?/, ""))
    .join(" ")
    .replace(/\*\*/g, "")
    .split(/\s+/)
    .join(" ")
    .trim();

const FROM = "never write a COUNT or a tally into prose";
const TO = "#### Fallback: hand-dispatched reviewer member";
const rule = () => flatten(between(RUN_TEAM, FROM, TO, "the immutable-body claim rule"));

// The phase-0 restatement of what phase 2 hands a `class=correction` implementer.
// A separate slice, far from the rule itself, because that enumeration is a
// delivery surface in its own right and drifts independently of the block.
const PHASE0_FROM = "hands the implementer (settle every restated claim";
const PHASE0_TO = "and it is what any future tier";

test("the rule reaches the immutable body the diff does not carry, and says why review-time is too late", () => {
  const r = rule();
  // The artifacts, bound to the reason they need their own rule. "commit body"
  // alone is satisfied by any passing mention; what makes this a rule is that
  // the body is not in the diff every other rule here scopes to.
  assert.match(
    r,
    /a claim written into a commit body or a PR body.{0,400}?a pushed commit body is not in the diff/,
    "the rule no longer covers a commit or PR body as something the diff-scoped rules cannot reach",
  );
  // Immutability bound to the consequence that makes a later fix no exit. With
  // only "cannot be edited" the reader concludes the remedy is a follow-up
  // commit, which is a fresh instance of the same generator.
  assert.match(
    r,
    phrase("only retracted by a later commit, which is itself a fresh unverified historical claim"),
    "the rule no longer says a retraction is itself an unverified claim — read without it, 'fix it later' looks like an exit",
  );
  assert.match(
    r,
    phrase("So the check has to sit at write time, and review-time is already too late"),
    "the rule no longer places the check at write time, so it now reads as something a reviewer could catch instead",
  );
});

test("the settling command is pinned to the shipping commit, against the motivating one", () => {
  // One ordered span, not two presence checks. `ships` and `motivated` both
  // appear either way round, and the reversed reading — settle at the commit
  // that motivated the work — is exactly the generator this rule exists to
  // stop: it is what makes a number correct when it was learned and wrong when
  // it shipped.
  assert.match(
    rule(),
    phrase("re-run at the commit that ships it, not at the commit that motivated it"),
    "re-running the settling command is no longer pinned to the shipping commit against the motivating one, or the two have been swapped",
  );
});

test("the claim types stay at the widened scope, with attribution ranked above a line number", () => {
  const r = rule();
  // The whole list as one span. A separate presence check on each noun is
  // vacuous in this slice: the anti-count rule it opens on already carries
  // "count", so a narrowing back to measurement counts — the ticket's title
  // scope, which the brief ruled out — would leave that check green.
  assert.match(
    r,
    phrase("a line number, a SHA, an attribution of who said what, a positional reference and a count all rot the same way"),
    "the claim types narrowed — the rule no longer covers line numbers, SHAs, attributions and positional references alongside counts",
  );
  // The ranking, bound to the reason for it and to the case it is ranked
  // against. This is the brief's decisive point, and it inverts cleanly: "a
  // wrong line number is the worst of them" reads as sound advice and reds
  // here.
  assert.match(
    r,
    /an attribution is the worst of them, because the argument it carries collapses.{0,120}?while a wrong line number leaves the surrounding reasoning standing/,
    "the rule no longer ranks a false attribution above a wrong line number, or no longer gives the reason — that an attribution's argument collapses with it",
  );
});

test("the inline form is bound to what it buys, and to the claim that has to be dropped instead", () => {
  const r = rule();
  assert.match(
    r,
    phrase("the command goes inline, beside the claim"),
    "the rule no longer requires the settling command inline beside the claim it settles",
  );
  // The endings that make the rule decidable. "Write the command inline" alone
  // leaves a writer with an unsettleable claim no instruction at all, and the
  // reachable move there is to assert it bare. The marker ending is load-bearing
  // and not decorative: the cross-repo citation convention in this block —
  // pinned by `cross-repo-citation-prose.test.mjs` — directs foreign evidence to
  // be asserted as prose saying it cannot be settled from this repo, and a
  // settle-or-drop binary reads as a ban on exactly that, since a foreign
  // claim's settling command cannot be written HERE. Pinned as one ordered span
  // so the binary cannot come back by dropping the marker ending.
  assert.match(
    r,
    /can be re-run instead of trusted.{0,120}?settle it inline, mark it unsettleable from this repo per the citation convention above, or drop it/,
    "the rule no longer offers the unsettleable-from-this-repo marker as an ending — a settle-or-drop binary bans what the citation convention above sanctions",
  );
});

test("the `Verified:` header carries the rationale — a wrong figure under it is worse than none", () => {
  // The ticket's own "why a rule and not just a fix". Before this assert the
  // sentence sat in an unpinned gap: the ranking span stops at "leaves the
  // surrounding reasoning standing" and the worked-instance span starts at
  // "`f961cf2` and `acce6ee`", so deleting it left the whole suite green.
  // One ordered span, because `Verified:` alone recurs in this slice and a bare
  // presence check on it is satisfied by the `f961cf2`/`acce6ee` worked
  // instance. The single `*` in `*instead of*` is live text here — see the
  // `flatten` note — and this is the assertion that makes leaving it unstripped
  // load-bearing.
  assert.match(
    rule(),
    /`Verified:` is the construct a later reader trusts \*instead of\* re-deriving.{0,80}?worse than no figure at all/,
    "the rule no longer says why `Verified:` is the header that makes a wrong figure worse than none",
  );
});

test("the worked instance names both commits and the command that settles what they shipped", () => {
  const r = rule();
  // The example is the rule applied to itself: a claim about two commit bodies,
  // carrying the command that reads them. Pinning the SHAs alone would survive
  // the command being dropped, which is the half a reader needs to re-derive.
  assert.match(
    r,
    /`f961cf2` and `acce6ee` both close `Verified:` with `86\/86 across both test files`/,
    "the worked instance no longer names both commits that shipped the claim",
  );
  assert.match(
    r,
    phrase("`git log -1 --format=%b <sha> | grep -A2 Verified:` shows what each shipped"),
    "the worked instance lost its settling command — the rule now demonstrates the failure it forbids",
  );
});

test("the literal-path grep is forbidden AND the method that replaces it is given", () => {
  const r = rule();
  // Prohibition bound to remedy. Separately, a slice keeping "must never be a
  // literal-path grep" with the mutation method deleted stays green and leaves
  // a member told what not to run and nothing to run instead — the state the
  // issue was written in, where two successive greps returned two wrong
  // answers.
  assert.match(
    r,
    /must never be a literal-path grep.{0,500}?Replace the file with `MUTATED` in a throwaway copy, run the suite/,
    "the literal-path grep prohibition is no longer carried with the mutation method that replaces it",
  );
  // Why the grep fails, in both directions. One direction alone reads as a
  // precision problem a tighter pattern would fix, which is the refinement the
  // issue measured returning a second wrong answer.
  assert.match(
    r,
    /merely \*name\* it — comments included — and misses the files that build it/,
    "the rule no longer says a path grep both over-reports mentions and misses assembled paths — one direction alone reads as a pattern that needs tightening",
  );
  // The question the mutation actually answers, which is narrower than "reads".
  assert.match(
    r,
    phrase("that answers which ones depend on its contents"),
    "the mutation method no longer states what it settles — depending on a file's contents is a different question from naming its path",
  );
});

test("both hand-over enumerations name this rule — a relayed list carries only what it names", () => {
  // Delivery here is a controller copying an enumeration, not the block:
  // nothing in this repo renders this block into a member prompt verbatim, so
  // the enumerated sentences ARE the hand-over. Settle with
  // `grep -rn "correction-ticket discipline" skills/ agents/` — every hit
  // selects, annotates or pins the discipline, and none renders it. That a
  // controller in practice relays the enumeration and leaves the block behind
  // is a fleet-run observation and cannot be settled from this repo.
  //
  // The refuters' point stands and is not the defect: the block already carried
  // rules these enumerations omit. The anti-count rule was one, absent from the
  // phase-0 parenthetical before #402 —
  // `git show 38d9d15:skills/run-team/SKILL.md | sed -n '303,310p'
  // | grep -in "count\|tally"` exits 1 — which is why the phase-0 asserts cover
  // it too.
  assert.match(
    rule(),
    /The immutable-body rule earns the same place.{0,80}?every claim a commit body or a PR body asserts needs its settling command re-run at the commit that ships it, and written inline beside it/,
    "the hand-over enumeration no longer names this rule as one to give every implementer — a controller relaying the list drops it",
  );
  const phase0 = flatten(
    between(RUN_TEAM, PHASE0_FROM, PHASE0_TO, "the phase-0 hand-over enumeration"),
  );
  assert.match(
    phase0,
    phrase("a settling command re-run and written inline for every claim that goes into the commit or PR body"),
    "the phase-0 summary of what phase 2 hands the implementer no longer names the commit/PR-body rule",
  );
  assert.match(
    phase0,
    phrase("never a count in prose"),
    "the phase-0 summary lost the anti-count rule — it was absent here before #402 and is the same defect",
  );
});

test("a rewrapped rule still matches — these pins refuse drift, not reflow", () => {
  // The ACCEPT side. Re-wrapping this paragraph is not drift, and a pin that
  // reddened on it would be deleted by the next person who reflowed the file.
  // The fixture is DERIVED from the live text, never a quoted line: a quoted
  // one turns every reword into a red on the fixture guard rather than on the
  // pin, which is an accept control that reddens on the edits it exists to
  // accept.
  const raw = between(RUN_TEAM, FROM, TO, "the immutable-body claim rule");
  const body = raw.replace(/\n*#*\s*$/, "");
  // Re-wrapped narrower than the file's ~80 columns, so every wrap point lands
  // somewhere different from today's. At word boundaries, not one word per
  // line: an unconditional break would split the slice's own opening anchor and
  // red this test on the anchor rather than on the pin.
  const words = body.split(/\s+/).filter(Boolean);
  const lines = words.reduce((acc, w) => {
    const last = acc[acc.length - 1];
    if (last && `${last} ${w}`.length <= 45) acc[acc.length - 1] = `${last} ${w}`;
    else acc.push(w);
    return acc;
  }, []);
  const narrow = lines.join("\n");
  // Load-bearing: it reds if the source is already at this width, which would
  // make the rewrap a no-op and this whole test vacuous.
  assert.notEqual(narrow, body, "the rewrap fixture no longer changes the rule's wrapping — update it");
  // Replacer function, not a replacement string: `$&`, `$'` and `` $` `` are
  // interpreted in the latter, and this slice carries a `$` today in `%b`'s
  // neighbourhood the moment anyone adds a shell variable to the example.
  const flat = flatten(between(RUN_TEAM.replace(raw, () => narrow), FROM, TO, "rewrapped rule"));
  assert.match(flat, phrase("re-run at the commit that ships it, not at the commit that motivated it"));
  assert.match(flat, phrase("the command goes inline, beside the claim"));
  assert.match(flat, phrase("that answers which ones depend on its contents"));
});
