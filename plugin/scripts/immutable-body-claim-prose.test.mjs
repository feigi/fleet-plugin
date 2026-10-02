// A claim written into a commit body or a PR body needs its settling command
// re-run at the commit that ships it, written inline beside it, because a
// pushed body cannot be edited and none of the diff-scoped rules reach it. The
// rule itself and the literal-text `-F` rule live in the claim-discipline block
// every implementer agent body carries; run-team's SKILL.md keeps the rationale
// paragraph and the two settling-command paragraphs that follow it. This file
// pins both homes. The same block's anti-count rule is pinned in
// `fix-applier-correction-rules-prose.test.mjs`, as one ordered span.
//
// Measured against `origin/main` before this file existed: no test read the
// words `commit body` in `run-team/SKILL.md` at all, so the whole rule could be
// deleted with the suite green.
//
// SHAPE. The SKILL.md slice runs from the rationale paragraph to the
// `#### Fallback` heading that follows the settling-command paragraphs —
// bounded at both ends, so a presence check inside it says something about
// these paragraphs and not about the rest of the Reviewers section. The agent
// body's block is sliced from its own lead to the commit-incrementally block
// that follows it.
//
// THE CEILING, the same one `dispatch-block-pins-prose.test.mjs` records:
// these are pins on text being PRESENT. A sentence APPENDED after a pinned one
// that carves an exception out of it — "a claim already settled earlier in the
// branch needs no re-run" — touches no pinned fragment and stays green here.
// For the agent body that ceiling is closed elsewhere: the claim-discipline
// block is verbatim dispatch text, so `dispatch-block-golden-prose.test.mjs`
// holds a whole-block golden fixture of it and an appended carve-out reds
// there. The SKILL.md paragraphs are ordinary prose, and stay presence-pinned
// by ruling: a golden over them would red on every legitimate rewording, with
// no change-control convention to make that red a review point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase } from "./prose-pin.mjs";

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

const FROM = "Every implementer body carries the";
const TO = "#### Fallback: hand-dispatched reviewer member";
const rule = () => flatten(between(RUN_TEAM, FROM, TO, "the claim-discipline rationale and settling-command rules"));

// The claim-discipline block of the implementer agent body — the hand-over
// itself, since the harness injects that body as every implementer's system
// prompt.
const AGENT = readFileSync(join(REPO, "agents", "fleet-implementer.agent.md"), "utf8");
const discipline = () =>
  flatten(between(AGENT, "**Claim discipline, on every ticket:**", "Commit incrementally as you go", "the agent body's claim-discipline block"));

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

test("a settling command over literal text takes -F, and its zero counts only after a known match", () => {
  const r = rule();
  // #1087. The `-F` half, bound to the measured case that shows why: a
  // literal line holding `\s+` is read as a pattern and answers 0 against
  // itself. Without the case the rule reads as style, not as a false zero.
  assert.match(
    r,
    phrase("A settling command over literal text uses `grep -F`"),
    "the rule no longer tells a settling command over literal text to use grep -F",
  );
  assert.match(
    r,
    phrase("`grep -c 'settled by:\\s+x'` answers 0 against a file holding that exact line, and `grep -cF` answers 1"),
    "the -F rule lost the measured case it rests on — the bare grep answering 0 against its own literal line",
  );
  // The positive-control half, which the `-F` half does not imply: a command
  // with `-F` can still be one that never finds a match, and its zero then
  // settles nothing while reading as a checked absence.
  assert.match(
    r,
    phrase("A zero or an absence counts only after the same command, with the same flags, finds a line known to match"),
    "the rule no longer requires a settling command to find a known match before its zero is trusted",
  );
  assert.match(
    r,
    phrase("a command that cannot find a match settles nothing"),
    "the rule no longer says a command incapable of finding a match settles nothing",
  );
  // #1087's ruling: the trap is harness-independent, so the rule names no
  // grep implementation or harness. A tool-specific warning goes false on the
  // next harness while reading as the whole of the rule. Substring match, no
  // leading `\b` before `bsd` — `\bbsd\b` cannot match inside "FreeBSD" (no
  // boundary between "ree" and "BSD"), and this repo's own dev grep reports
  // itself as "2.6.0-FreeBSD" (measured), so that miss is not hypothetical.
  assert.doesNotMatch(
    paragraph(RUN_TEAM, "**A settling command over literal text uses `grep -F`", "the literal-text grep rule"),
    /ugrep|ripgrep|claude code|bsd|gnu/i,
    "the literal-text grep rule now names a grep implementation or harness — #1087 ruled it harness-independent",
  );
});

test("the rationale says why every implementer gets the discipline and why a body claim is settled at write time", () => {
  const r = rule();
  assert.match(
    r,
    phrase("Nothing before dispatch can see the diff, so the discipline goes to every implementer"),
    "the rationale no longer says why the discipline reaches every implementer rather than a selected few",
  );
  assert.match(
    r,
    phrase("A pushed commit body cannot be edited, so its claims are settled at write time"),
    "the rationale no longer says why a commit-body claim is settled at write time",
  );
});

test("the agent body hands every implementer the commit/PR-body rule", () => {
  assert.match(
    discipline(),
    phrase("Every claim in a commit body or PR body gets its settling command re-run at the commit that ships it, written inline beside the claim"),
    "the agent body no longer carries the commit/PR-body rule",
  );
});

test("the agent body hands every implementer the literal-text -F rule, positive control included", () => {
  assert.match(
    discipline(),
    phrase("A settling command over literal text uses `grep -F`, and its zero counts only after the same command, with the same flags, finds a line known to match"),
    "the agent body no longer tells an implementer that literal text is grepped with -F, its zero trusted only after a known match",
  );
});

test("a rewrapped rule still matches — these pins refuse drift, not reflow", () => {
  // The ACCEPT side. Re-wrapping this paragraph is not drift, and a pin that
  // reddened on it would be deleted by the next person who reflowed the file.
  // The fixture is DERIVED from the live text, never a quoted line: a quoted
  // one turns every reword into a red on the fixture guard rather than on the
  // pin, which is an accept control that reddens on the edits it exists to
  // accept.
  const raw = between(RUN_TEAM, FROM, TO, "the claim-discipline rationale and settling-command rules");
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
  assert.match(flat, phrase("A pushed commit body cannot be edited, so its claims are settled at write time"));
  assert.match(flat, phrase("that answers which ones depend on its contents"));
  assert.match(flat, phrase("A zero or an absence counts only after the same command, with the same flags, finds a line known to match"));
  assert.match(flat, phrase("A settling command over literal text uses `grep -F`"));
});
