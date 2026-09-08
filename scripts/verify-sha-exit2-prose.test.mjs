// #558. The "Verify every reported SHA" guard is the ONLY consuming-side rule
// for `verify-sha.sh`, and it named exactly one outcome — "Not reachable →
// flag" — so a controller following it literally had no instruction for exit 2,
// "the question could not be answered". In `sh`, both `cmd || handle` and
// `if cmd; then` treat 1 and 2 alike, so the natural reading files an
// unanswerable probe under "not reachable" by accident rather than by rule.
//
// That accident is fail-safe TODAY only because exit 2 emits no JSON at all: a
// controller cannot read `reachable:true` off it. It is not fail-safe in the
// other direction — an unanswerable probe recorded as a real "not reachable"
// verdict flags a member for a stray commit that was never demonstrated, and
// holds its ticket out of the pool "until the maintainer rules" over a failure
// that a re-run would have cleared.
//
// The pins below are the rules the corrected guard has to carry, each checked
// against `verify-sha.sh` itself before being written down:
//
//   1. the three exit codes are named where the command is named, the inline
//      convention `next-ticket/SKILL.md` already uses for `inflight.sh`;
//   2. exit 1 KEEPS its verdict — the flag, the withheld enqueue and the
//      maintainer's ruling still hang off "not reachable", and exit 2 is not
//      allowed to drift into that gap. This is the pin against the fix
//      overshooting: a guard that teaches "non-zero is unanswerable" destroys
//      the one distinction the script exists to make;
//   3. exit 2 gets its own remedy — read stderr, re-run, escalate on repeat —
//      and exit 1's remedy is not allowed to drift into THAT gap;
//   4. the exit-2 branch is stated as a PROPERTY of the exit code, not as a
//      list of causes. Every `die()` in the script produces the identical
//      caller-visible shape (no stdout, cause on stderr), so a cause list adds
//      nothing a controller can act on differently — and it rots on the next
//      commit that adds or removes one. Test 4 forbids the tally outright.
//
// Rule 4 is why this file pins no number. `verify-sha.sh`'s exit-2 paths have
// already grown twice — the `merge-base --is-ancestor` guard, then #119's three
// JSON-escaping guards — and the issue that asked for this fix was filed
// before the last of those landed: its count was accurate when written, and
// stale by the time this fix was. A number written here would age the same way.
//
// THE CEILING, same as inflight-exit2-prose.test.mjs: these are PRESENCE pins
// over a bounded slice, plus two adjacency pins. Text spliced INSIDE a pinned
// phrase reddens them; a whole new sentence appended after one, carving out an
// exception, does not. A reflow (line wraps, `**bold**` moved) stays green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("skills", "run-team", "SKILL.md");
const SCRIPT = read("scripts", "verify-sha.sh");

// Bounded at both ends and small: the guard, not the `## Guards` section. A
// slice wide enough to reach its neighbours is satisfied by their vocabulary.
const guard = () =>
  between(RUN_TEAM, "**Verify every reported SHA.**", "**Never `--delete-branch`", "run-team/SKILL.md");

// Bold moves, and these pins must not care. `**` is allowed at ANY word
// boundary inside a pinned phrase: markdown emphasis slides around a sentence
// without changing what the sentence says, so a pin that reds on a moved `**`
// pins the formatting rather than the rule. One `\*{0,2}` per pin — the first
// spelling — closed only the seam its own instance happened to use, and every
// other seam still reddened. Measured: `Exit 2 is **not a verdict**` and `Not
// reachable **(exit 1)**` are both what an editor emphasising this guard
// writes, and both were false reds. The tolerance goes INSIDE the gap
// lookaheads too, or `**Exit** 2` drifts straight through the exclusion the
// gap exists to enforce — measured green before this was widened.
const B = String.raw`\*{0,2}`; // an optional bold marker at one seam
const S = String.raw`\*{0,2}\s+\*{0,2}`; // a word gap that tolerates one
const EXIT2_VERDICT = String.raw`[Ee]xit${S}2${S}is${S}not${S}a${S}verdict`;

// The guard's required annotation, in the form the guard writes it. Shared, so
// the pin below and the assertion that the annotation survives that pin are
// provably about the same string rather than two copies that can drift apart.
const ANNOTATION = "`# 0 reachable, 1 not reachable, 2 unanswerable`";

// The tally is the rot. A written count is false the moment a `die()` is added
// or removed, and this script's set has already changed twice.
//
// Scoped to the COUNTED NOUN, not to a bare number near "exit 2": the annotation
// this same guard carries is `2 unanswerable`, which is the exit code's meaning
// and must stay. Measured — the first spelling of this pin reddened on the
// guard's own correct text, and `reachable`/`unanswerable` are what the exit
// codes MEAN, so neither can ever go in this list.
//
// What separates a tally from prose is the NUMBER, not the noun: in a tally the
// number counts something, and in this guard's correct sentences the number is
// an exit code with `exit` in front of it. The lookbehind refuses a number the
// exit token directly precedes, and that is what carries the noun list —
// measured, the spelling this replaces reddened on `Escalate exit 2 on all
// paths by pinging the maintainer`, and `ways?` could not be admitted at all
// because it reddened on `Treat exit 2 the same way in all cases`. Both are
// prose. Both are green here, and every counted-noun spelling below stays red.
//
// The separator inside the lookbehind takes a hyphen as well as a space, or
// `exit-2` — how this repo writes the branch — reads as a count and reds. It
// takes `**` on either seam for the reason `S` does: a lookaround cannot see a
// bold-split token, so `**Exit** 2` would walk straight through it. The
// optional `code`/`codes` token is in for the reason the hyphen is: `exit code
// 2` names the same exit code, and measured, without that token `Treat exit
// code 2 the same way in all cases.` reddened while `Treat exit 2 …` did not.
// The seam tolerance repeats around it, or `**exit code** 2` walks through the
// same way `**Exit** 2` would. Case comes from the `i` flag, and `[Ee]` keeps
// the exclusion working if that flag is ever narrowed — an exclusion that stops
// firing is a green over the rot itself.
//
// The nouns this change adds are here because each was measured missing, not
// guessed: every one of them let `three unanswerable <noun> here` through green
// against the spelling this replaces. The nouns already in that spelling stay
// as they are; the loop that pins every noun carries the per-noun history.
//
// THE CEILING: this is still a list, so a counted noun nobody has thought of
// still passes. The filler window between the number and the noun also stays
// narrow — `three distinct kinds of ways` overruns it and is green, on this
// spelling and on the one it replaces. Widening that window is what let a noun
// reach an exit code in the first place, so it stays as it is.
//
// The exclusion is ADJACENCY, so correct prose that puts anything between the
// exit token and its number still reds: measured, `Treat exit codes 1 and 2 the
// same way in all cases.` reds here and was green against the spelling this
// replaces, because `and` sits where the exit token would have to be. No
// lookbehind reaches that one — it is a false red that admitting `ways?`
// opened, and this spelling does not close it.
const TALLY = new RegExp(
  String.raw`(?<![Ee]xit(?:\*{0,2}[-\s]+\*{0,2}codes?)?\*{0,2}[-\s]+\*{0,2})` +
    String.raw`\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:\w+[-\s]+){0,2}` +
    String.raw`(?:paths?|causes?|cases?|reasons?|branches|conditions?|outcomes?|scenarios?|situations?|types?|ways?|(?:failure\s+)?modes?)\b`,
  "i",
);

test("the guard names the script's exit codes where it names the command", () => {
  assert.match(guard(), phrase(ANNOTATION));
});

test("exit 1 keeps the verdict — the flag, the held enqueue and the maintainer's ruling", () => {
  // ADJACENCY, not three presence pins: each clause on its own survives the
  // subject being swapped to exit 2, which is the overshoot this guards.
  // `[Ee]xit 2` excluded from the gap so the two branches cannot merge into
  // one. The character class is load-bearing, not decoration: a drifting
  // sentence that opens on the code capitalises it, which a bare `exit` misses.
  assert.match(
    guard(),
    new RegExp(
      String.raw`[Nn]ot${S}reachable${B}\s*${B}\(exit${S}1\)${B}\s*${B}→\s*${B}flag` +
        String.raw`(?:(?!${B}[Ee]xit${S}2)[\s\S]){0,200}?until${S}the${S}maintainer${S}rules`,
    ),
    "the not-reachable branch no longer binds exit 1 to flag/hold/maintainer-rules, or exit 2 has drifted into that gap — an unanswerable probe must never spend a maintainer's ruling",
  );
});

test("exit 2 is not a verdict and carries its own remedy", () => {
  assert.match(guard(), new RegExp(EXIT2_VERDICT));
  // Same adjacency shape, mirrored: exit 1's remedy must not drift into the
  // exit-2 gap either. Re-running a genuine "not reachable" hides a stray
  // commit behind a probe that answers the same way every time.
  assert.match(
    guard(),
    new RegExp(EXIT2_VERDICT + String.raw`(?:(?!${B}[Ee]xit${S}1)[\s\S]){0,400}?re-run`),
    "the exit-2 branch no longer tells the controller to re-run, or exit 1 has drifted into its gap",
  );
  assert.match(guard(), phrase("never record it as a stray commit"));
});

test("the exit-2 branch is stated as a property of the code, never as a tally of causes", () => {
  // The property that makes one rule cover every cause: the caller cannot tell
  // them apart, so it must key on the code.
  assert.match(guard(), phrase("no JSON on stdout"));
  assert.match(guard(), phrase("the cause on stderr"));

  // Whether the PIN works is settled before the guard is judged by it, because
  // an assertion that fails masks every one after it and the messages are not
  // interchangeable. Measured: with the pin's noun list widened to reach the
  // annotation, the guard's own verdict fired first and reported that a count
  // had been written into the guard — false, about text that is correct and
  // required to be there. The honest message existed and never ran.
  //
  // What the pin CATCHES, asserted rather than inferred: every assertion over
  // the guard here is a `doesNotMatch`, and those are green against a regex
  // that matches nothing. Measured — a pin emptied to `/$^/` left this whole
  // file green before these landed, guard verdict included.
  //
  // The spellings are the counted nouns that would express a tally in this
  // guard, each measured to have passed green before it was covered.
  for (const noun of [
    "paths",
    "causes",
    "cases",
    "reasons",
    "branches",
    "failure modes",
    "modes",
    "conditions",
    "outcomes",
    "scenarios",
    "situations",
    "types",
    "ways",
  ]) {
    assert.match(
      `There are three unanswerable ${noun} here.`,
      TALLY,
      `the tally pin stopped reading a count spelled with "${noun}" — that is the rot rule 4 forbids, wearing a word the pin no longer sees`,
    );
  }
  // And what it must REFUSE to catch. Every widening of this pin risks
  // reddening correct text, and correct text here is number-adjacent by
  // construction — the guard names exit codes for a living. In each of these
  // the number is an exit code, not a count, which is the property the pin
  // keys on; the hyphen spelling is in because this repo writes the branch
  // that way and a whitespace-only exclusion reds on it, and the `exit code`
  // spellings are in because the exclusion has to carry across that token and
  // its bold seam — both measured red before it did.
  for (const correct of [
    "Treat exit 2 the same way in all cases.",
    "Escalate exit 2 on all paths by pinging the maintainer.",
    "Escalate exit-2 on all paths by pinging the maintainer.",
    "Treat **Exit** 2 the same way in all cases.",
    "Treat exit code 2 the same way in all cases.",
    "Treat **exit code** 2 the same way in all cases.",
  ]) {
    assert.doesNotMatch(
      correct,
      TALLY,
      `the tally pin reddens on correct prose: "${correct}" states no count — the number in it is an exit code, and a pin that cannot tell those apart fires on edits that are right`,
    );
  }
  // The annotation keeps its own message rather than joining the sentences
  // above: what goes wrong here is a noun list reaching a REQUIRED string, and
  // naming the two words that can never join that list is what sends the reader
  // to the fix instead of to the guard.
  assert.doesNotMatch(
    ANNOTATION,
    TALLY,
    "the tally pin's noun list now reaches the guard's own required annotation — `reachable` and `unanswerable` are what the exit codes MEAN, not a count of causes",
  );

  // Only now the guard itself, judged by a pin already shown to discriminate.
  assert.doesNotMatch(
    guard(),
    TALLY,
    "a count of exit-2 paths has been written into the guard — state the property instead; the next `die()` added to verify-sha.sh falsifies the number",
  );
});

test("verify-sha.sh still declares the exit codes the guard quotes", () => {
  // Cross-file coupling, otherwise invisible: the guard's annotation is a copy
  // of the script's contract. If the script's codes change, the doc lies and
  // nothing else says so.
  assert.match(SCRIPT, phrase("Exit 0 reachable, 1 not reachable, 2 the question could not be answered"));
  // Every exit-2 path is the same `die`, which is what lets one rule cover all
  // of them. A second exit-2 spelling would need the guard revisited.
  assert.match(SCRIPT, /^die\(\)\s*\{[^}]*exit 2;?\s*\}/m);
  // Comment lines stripped first: this script is two-thirds prose about its own
  // exit codes, and counting the raw substring reds on a comment that merely
  // MENTIONS exit 2 — with a message sending the reader after a code path that
  // does not exist (measured). `\b` also stops `exit 22` from counting. Whole
  // comment lines only, never a trailing `#`: cutting at one would let a `#`
  // inside a quoted string hide a genuine second exit, and a missed exit
  // defeats the assertion, where a comment it still trips is merely loud.
  //
  // No null guard: the `die()` pin above carries this same `exit 2` literal on a
  // line that is not a comment, so reaching here means a match already exists.
  assert.equal(
    SCRIPT.replace(/^\s*#.*$/gm, "").match(/\bexit 2\b/g).length,
    1,
    "verify-sha.sh grew a second way to exit 2 — the guard's single rule covers every cause only because `die()` is the sole one",
  );
});
