// #348. Three claims in `.github/workflows/ci.yml`'s comments went stale
// against the tree they describe, and nothing here noticed:
//   - the Shellcheck comment named two info-level hits and called them the only
//     ones, then told the next maintainer to raise the gate "after silencing
//     those two";
//   - the Tests comment sized `skills/fleet/scripts/` in flat files;
//   - the same paragraph put quotation marks around a sentence it attributed to
//     `claim-ticket.sh`, and the quoted words were not that file's words.
//
// All three share one shape: prose that pins a measurable property of a file it
// does not own. The fixes are the two durable forms — delete the measurement
// where it carries no argument, and anchor the quotation on text that has to
// still exist. This file is what keeps them that way.
//
// What it deliberately does NOT do is pin any count. `run-team`'s tier
// paragraph learned that in PR #554: a pin coupling prose to a moving figure
// goes red on every legitimate edit, so it gets deleted or routed around. The
// Shellcheck assertion below bans the exhaustive FORM, not any number, and the
// citation assertion accepts a paraphrase — dropping the quotation marks is one
// of the two fixes #348 named, so a test that refused it would refuse the fix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Comment prose only, wrap-invisible. Every claim below spans a hard wrap, so a
// fragment only matches once the `#` markers and the line breaks are gone —
// same convention as the other *-prose tests. A comment line is one whose
// FIRST non-space character is `#` — which excludes a trailing `# …` on a code
// line and a `#` inside a `run:` string alike, and sweeps in the whole-line
// shell comments inside `run:` blocks. Prose meant to be pinned here therefore
// has to live in a whole-line comment.
const prose = (src) =>
  src
    .split("\n")
    .filter((l) => /^\s*#/.test(l))
    .map((l) => l.replace(/^\s*#\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");

const CI = prose(read("../../../.github/workflows/ci.yml"));
const CLAIM_TICKET = prose(read("./claim-ticket.sh"));

/**
 * The citation rule, as a function so the accept case can be fed input this
 * repo does not contain. Returns null when the pair is sound, else the reason.
 */
export function citationFault(citing, cited) {
  if (!citing.includes("claim-ticket.sh")) {
    return "ci.yml no longer names claim-ticket.sh — the vendored-tree argument lost the source it rests on";
  }
  // The citing SENTENCE, and EVERY quoted span in it. Two separate traps.
  // Scanning unbounded (`[^"]*"([^"]+)"`) runs to the next quote anywhere later
  // in the prose, so the moment the citation is paraphrased — one of the two
  // fixes #348 sanctions — the rule re-attaches to an unrelated quoted phrase
  // further down ci.yml and demands claim-ticket.sh contain that. Taking only
  // the FIRST span is the silent direction: an aside that does quote the file
  // stands in front of a misquote and absorbs the whole check. The early return
  // above is what guarantees this match is non-null.
  const sentence = citing.match(/claim-ticket\.sh[^.]*/)[0];
  // No quoted span at all is a paraphrase: nothing claims to be verbatim, and
  // dropping the quotation marks is the other of the two fixes #348 sanctions.
  for (const [, quoted] of sentence.matchAll(/"([^"]+)"/g)) {
    if (!cited.includes(quoted)) {
      return `ci.yml quotes claim-ticket.sh as saying "${quoted}", and that file does not say it`;
    }
  }
  return null;
}

test("ci.yml's quotation of claim-ticket.sh is that file's own words", () => {
  assert.equal(citationFault(CI, CLAIM_TICKET), null);
});

// The other half. A guard that only ever sees the one input this tree holds
// pins nothing about what it REFUSES, and #348's own fix section offered two
// remedies — fix the words, or drop the quotation marks and paraphrase. The
// second one has no quoted span at all, so a rule keyed on finding one would
// red on a sanctioned fix.
test("a paraphrase is accepted; a deleted citation and a misquote are not", () => {
  const cited = "so this walk, not node, is what keeps vendored tests out.";

  assert.equal(citationFault('see claim-ticket.sh, which says so itself: "walk, not node"', cited), null);
  assert.equal(citationFault("claim-ticket.sh makes the same point about its own walk", cited), null);

  assert.match(citationFault("the find in the emitted runner is what does it", cited), /no longer names/);
  assert.match(citationFault('claim-ticket.sh says: "this filter, not node"', cited), /does not say it/);
});

test("the Shellcheck comment does not present its examples as the complete set", () => {
  // Not a count — a count is the thing that rotted. This bans the two phrases
  // that made the list exhaustive, so the next edit can add or drop an example
  // freely and only a re-closed enumeration reds.
  assert.doesNotMatch(
    CI,
    /only info-level hits/,
    "the Shellcheck comment claims an exhaustive list of info-level hits again — #348 removed that because the tree has more than the ones it names",
  );
  assert.doesNotMatch(
    CI,
    /those two at the source/,
    "the Shellcheck comment tells the next maintainer to silence `those two` again — the set it points at is not two",
  );
});

// #953. The same file, the same failure mode, one axis over: a rationale can rot
// by MOVING rather than by going stale. The failglob paragraph drifted above the
// gojq provisioning block and two steps it says nothing about, so a reader at the
// step it explains had to scroll past an unrelated toolchain to find it. Nothing
// caught that, for the reason ci.yml states about itself: no test reads its
// comments. Anchored on what the paragraph SAYS and on the step's name, never on
// a line number — the drift this pins is exactly a line number changing.
test("the failglob rationale sits against the Tests step it documents", () => {
  const lines = read("../../../.github/workflows/ci.yml").split("\n");
  const anchor = lines.findIndex((l) => /^\s*#.*failglob/.test(l));
  assert.ok(anchor >= 0, "ci.yml no longer explains in prose why the Tests step sets failglob");
  let i = anchor;
  while (/^\s*#/.test(lines[++i]));
  assert.match(
    lines[i],
    /^\s*- name: Tests$/,
    `the failglob rationale documents the Tests step but is followed by "${lines[i]}" — it has drifted away from the step it explains`,
  );
});

test("the vendored-tree sentence makes a structural claim, not a size claim", () => {
  // The sentence exists to say there is nothing to walk INTO under that
  // directory. A file count neither supports that nor survives a commit.
  // A fixed window, not the sentence: `[^.]*` stops at the first period, and
  // the count reads exactly the same re-added as the NEXT sentence as it did
  // after a semicolon, which is the form #348 deleted.
  const span = CI.match(/no vendored tree under skills\/fleet\/scripts\/.{0,120}/);
  assert.ok(span, "ci.yml no longer argues that skills/fleet/scripts/ holds no vendored tree");
  assert.doesNotMatch(
    span[0],
    /\d/,
    `the vendored-tree claim sizes the directory again, and the number is stale on arrival: "${span[0]}"`,
  );
});
