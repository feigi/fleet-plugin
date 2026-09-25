// #503. The refuter prompt orders a verification RUN and never said how to
// observe it. Measured: refuters independently reach for
// `until grep -q "<marker>" <log>; do sleep N`, and one waited on the tap `#`
// prefix while node wrote the spec one, so the marker could never appear and
// the loop was infinite — the transcript froze and the finding went unchecked.
//
// Accepting both prefixes is necessary but NOT sufficient, which is why the
// prefix pin and the SGR pin below are ONE span and not two. Measured on
// node v26.7.0, `node --test` against a three-test file, piped through `cat -v`:
//
//   env -u FORCE_COLOR  -> "ℹ pass 3"
//   FORCE_COLOR=1       -> "\x1b[34mℹ pass 3\x1b[39m"
//   env FORCE_COLOR=    -> "\x1b[34mℹ pass 3\x1b[39m"   <- NOT a control
//   script -q /dev/null -> "\x1b[34mℹ pass 3\x1b[39m"   <- a TTY colors too
//
// The colored line begins with ESC, so an anchor on either prefix matches
// nothing and returns empty at exit 0 — the same shape as a hung run and as a
// zero-test run. That is why `env -u FORCE_COLOR` is pinned as the control:
// `FORCE_COLOR=` empty colors identically to `FORCE_COLOR=1`, so a baseline
// taken with it silently is not a baseline.
//
// THE TAP PREFIX WAS NOT REPRODUCED AS A DEFAULT. Only node v26.7.0 is
// installed here and it emits the spec prefix even when piped, so the `#`
// form was only observed under an explicit `--test-reporter=tap`. The rule is
// therefore written to be SAFE under a prefix this machine cannot produce
// rather than asserting what was not measured — which is also why it demands
// SGR stripping instead of a wider prefix alternation.
//
// All THREE live dispatch sites are pinned, not the two the ticket counted:
// `grep -rn 'Try to REFUTE this finding'` finds the instruction quoted
// verbatim in run-team/SKILL.md's fix-applier block, in review-and-fix.md
// step 2, and in the workflow's own prompt in review-pr.js.
// refuter-scratch-prose.test.mjs already ruled the reason — "a fix added to
// only one is the one that does not reach whichever path a given caller
// takes".
//
// THE CEILING, same as refuter-scratch-prose.test.mjs: these are PRESENCE pins
// over a bounded slice, each a single regex. Every join is `\s+` and no pin
// carries a `.{0,N}` gap, because a bounded gap is not a join — it is slack,
// and slack holds a sentence. Measured: the earlier `.{0,200}` gap between the
// poll ban and its carve-out bridged 107 characters of real prose, so
// substituting a sentence that reinstates polling for that prose kept all
// three sites green. A splice inside a `\s+`-joined span cannot: it has
// nowhere to land. What a presence pin still cannot catch is a whole new
// sentence appended AFTER the span carving out an exception — that is what the
// negative pin at the bottom of this file is for, and why it bans the wait
// vocabulary rather than three literal idioms. A reflow stays green by design:
// the words are pinned, not their layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");

// Two source shapes reach these regexes. run-team/SKILL.md's copy sits in a
// nested `> > ` blockquote, so a hard wrap lands with the quote gutter — not
// whitespace — at the break, and `\s+` does not span `>`. review-pr.js's copy
// is inside a template literal, so every backtick in it is BACKSLASH-ESCAPED
// in the source text; unescape them or every pin naming a code span fails on
// that file alone. Both normalizations are harmless on review-and-fix.md.
const norm = (text) =>
  text
    .split("\n")
    .map((l) => l.replace(/^(>\s?)+/, ""))
    .join(" ")
    .replace(/\\`/g, "`");

const SITES = [
  [
    "run-team/SKILL.md",
    () =>
      norm(
        between(
          read("skills", "run-team", "SKILL.md"),
          "Try to REFUTE this finding",
          "Survives → apply it, with one hold",
          "run-team/SKILL.md",
        ),
      ),
  ],
  [
    "review-and-fix.md",
    () =>
      norm(
        between(
          read("commands", "review-and-fix.md"),
          "Try to REFUTE this finding",
          "That last clause is the whole mechanism",
          "review-and-fix.md",
        ),
      ),
  ],
  [
    "review-pr.js",
    () =>
      norm(
        between(
          read("workflows", "review-pr.js"),
          "Try to REFUTE this finding",
          "Scratch: ",
          "review-pr.js",
        ),
      ),
  ],
];

for (const [name, getPrompt] of SITES) {
  // ONE span from the exit-code rule through the poll ban to the carve-out,
  // joined by `\s+` and nothing wider. Split into separate assertions — or
  // joined by a `.{0,N}` gap, which is the same thing with extra steps — these
  // would let a sentence reinstating a wait loop sit between them and stay
  // green; that is the splice defect refuter-scratch-prose.test.mjs pins
  // against, and it was measured live on all three sites here before this span
  // was closed. The middle clause is therefore pinned, not skipped over. The
  // carve-out rides in the same span deliberately: a poll ban with no statement
  // of what a refuter MAY still do reads as a ban on reading logs at all, and a
  // refuter that cannot read a finished log cannot verify anything.
  test(`${name}: refuter observes a run synchronously by exit code, never by polling a log`, () => {
    assert.match(
      getPrompt(),
      /run\s+the\s+command,\s+wait\s+for\s+it,\s+read\s+its\s+exit\s+code\.\s+Never\s+poll\s+a\s+log\s+file\s+for\s+a\s+completion\s+marker:\s+prefer\s+ONE\s+blocking\s+run\s+to\s+a\s+poll\s+loop,\s+and\s+treat\s+its\s+return\s+as\s+permission\s+to\s+look,\s+never\s+as\s+the\s+answer\.\s+Reading\s+a\s+log\s+the\s+run\s+has\s+already\s+finished\s+writing\s+is\s+fine/,
      "the synchronous-observation rule is broken — either the exit-code rule is gone, or the poll ban is gone (a refuter reaches for `until grep <marker>` and wedges forever on a marker that can never appear), or the clause preferring one blocking run is gone, or the carve-out permitting a finished log is gone, or a sentence was spliced between them reinstating a wait",
    );
  });

  // Both halves in ONE span, because either alone is the measured defect: the
  // dual-prefix matcher `grep -E "^(ℹ|#) fail"` is exactly what a colored run
  // defeats, and SGR stripping without both prefixes false-refuses on a node
  // whose default reporter differs.
  test(`${name}: a reporter-output matcher needs both prefixes AND SGR stripping, neither alone`, () => {
    assert.match(
      getPrompt(),
      /accepting\s+both\s+`ℹ`\s+and\s+`#`\s+is\s+necessary\s+but\s+NOT\s+sufficient\s+—\s+strip\s+SGR\s+escapes\s+first/,
      "the reporter-matching rule lost a half — dual prefixes alone is the matcher a colored run was MEASURED to defeat (the line begins with ESC, so no prefix anchor matches and the result is empty at exit 0, indistinguishable from a hung run), and SGR stripping alone false-refuses across node versions",
    );
  });

  // The control, and why it is one. Pinned as a span with the refutation
  // attached: `env -u FORCE_COLOR` on its own invites the `FORCE_COLOR=`
  // spelling back, which colors identically and silently is not a baseline.
  test(`${name}: the uncolored baseline is env -u FORCE_COLOR, and says why the empty spelling is not`, () => {
    assert.match(
      getPrompt(),
      /`env\s+-u\s+FORCE_COLOR`;\s+`FORCE_COLOR=`\s+empty\s+still\s+enables\s+color,\s+so\s+it\s+is\s+not\s+a\s+control/,
      "the baseline control is broken — an `env FORCE_COLOR= ...` baseline is colored, so every comparison run against it is invalid, and dropping the reason is what lets the wrong spelling come back",
    );
  });

  // Both clauses in one span, `\s+`-joined: a scope-only rule was measured to
  // catch one of the two refuted negative claims and NOT the other, whose scope
  // was stated accurately and was still the wrong scope for the claim. The two
  // `.{0,160}` gaps this span used to carry bridged 3 and 27 characters of real
  // text, so each held room for a sentence retracting the rule between its own
  // halves.
  test(`${name}: a negative claim states its search scope AND what the pattern would have missed`, () => {
    assert.match(
      getPrompt(),
      /State\s+your\s+search\s+scope\s+AND\s+what\s+your\s+pattern\s+would\s+have\s+missed\.\s+A\s+grep\s+over\s+one\s+ref\s+does\s+not\s+support\s+a\s+claim\s+about\s+history;\s+a\s+pattern\s+built\s+from\s+the\s+token\s+a\s+diff\s+removed\s+does\s+not\s+support\s+a\s+claim\s+that\s+the\s+category\s+is\s+empty/,
      "the negative-claim rule lost a half — stating scope alone does not catch a pattern built from the token a diff removed, which was the measured second refutation",
    );
  });

  // The acceptance criterion is that a wait appears nowhere as endorsement. A
  // presence pin cannot express that; this is the negative half, and it must
  // fire regardless of SPELLING — the sentence measured to defeat the old pins
  // ("poll the log until the marker appears") contains none of the three shell
  // idioms the ban used to enumerate. So ban the vocabulary instead, after
  // removing the rule's own two sanctioned mentions of polling. Removing them
  // hides nothing: both are inside the `\s+`-joined span the first test pins
  // verbatim, so deleting or rewording either reddens there first. `replace` is
  // deliberately non-global — a SECOND "poll" is exactly what this catches.
  test(`${name}: the refuter prompt never spells a wait on a log as something to do`, () => {
    const rest = getPrompt()
      .replace(/Never\s+poll\s+a\s+log\s+file\s+for\s+a\s+completion\s+marker/, "")
      .replace(/prefer\s+ONE\s+blocking\s+run\s+to\s+a\s+poll\s+loop/, "");
    assert.doesNotMatch(
      rest,
      /poll|sleep|tail\s+-f|while\s+!|watch(?:ing)?\s+the\s+log|until\s+\S+\s+(?:appears|shows|exists|is\s+written)/i,
      "the refuter prompt now spells a wait on a log — the idiom this brief exists to ban reads as endorsement wherever it appears in an instruction handed to an agent verbatim, and a reinstatement does not have to reuse the brief's own words to be one",
    );
  });
}

// Every slice above starts at the same anchor, and `between()` takes the FIRST
// match — by contract, pinned in prose-pin.test.mjs, so the guard cannot go
// there. Measured on a copy: a partial quote planted earlier is harmless (it
// either reds on the `to` anchor or widens the slice into a superset that still
// catches drift), but a VERBATIM copy of the whole pinned span planted earlier
// silently retargets every pin at the copy, and real drift in the live prompt
// goes green on all three sites. The anchor is shared with
// refuter-scratch-prose.test.mjs and review-pr-reads.test.mjs, so this one
// guard covers their slices too.
for (const [name, ...p] of [
  ["run-team/SKILL.md", "skills", "run-team", "SKILL.md"],
  ["review-and-fix.md", "commands", "review-and-fix.md"],
  ["review-pr.js", "workflows", "review-pr.js"],
  ["review-core.mjs", "scripts", "review-core.mjs"],
]) {
  test(`${name}: the refuter-prompt slice anchor occurs exactly once`, () => {
    assert.equal(
      read(...p).split("Try to REFUTE this finding").length - 1,
      1,
      `${name} contains "Try to REFUTE this finding" more than once — every pin over this file slices from the FIRST occurrence, so a second copy silently moves what they check away from the live prompt`,
    );
  });
}
