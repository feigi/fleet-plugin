// #348. Three claims in `.github/workflows/ci.yml`'s comments went stale
// against the tree they describe, and nothing here noticed:
//   - the Shellcheck comment named two info-level hits and called them the only
//     ones, then told the next maintainer to raise the gate "after silencing
//     those two";
//   - the Tests comment sized `scripts/` in flat files;
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

const CI = prose(read("../../.github/workflows/ci.yml"));
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
// comments. Anchored on the step's name, walking UP over the whole contiguous
// comment run above it — never on a line number, the drift this pins is exactly
// a line number changing — so a fix that reunites the step's NAME with its
// rationale while leaving one sibling paragraph behind still reds: the failglob
// paragraph is not the only one this step's reader needs.
test("the failglob rationale sits against the Tests step it documents", () => {
  const lines = read("../../.github/workflows/ci.yml").split("\n");
  const step = lines.findIndex((l) => /^\s*- name: Tests$/.test(l));
  assert.ok(step >= 0, "ci.yml no longer has a Tests step");
  let i = step;
  while (/^\s*#/.test(lines[i - 1])) i--;
  const block = lines.slice(i, step).join(" ");
  for (const claim of [/failglob/, /Explicit glob/, /stubs `gh`/]) {
    assert.match(
      block,
      claim,
      `the Tests step's rationale lost ${claim} — it has drifted away from the step it explains`,
    );
  }
});

test("the vendored-tree sentence makes a structural claim, not a size claim", () => {
  // The sentence exists to say there is nothing to walk INTO under that
  // directory. A file count neither supports that nor survives a commit.
  // A fixed window, not the sentence: `[^.]*` stops at the first period, and
  // the count reads exactly the same re-added as the NEXT sentence as it did
  // after a semicolon, which is the form #348 deleted.
  const span = CI.match(/no vendored tree under plugin\/scripts\/.{0,120}/);
  assert.ok(span, "ci.yml no longer argues that plugin/scripts/ holds no vendored tree");
  assert.doesNotMatch(
    span[0],
    /\d/,
    `the vendored-tree claim sizes the directory again, and the number is stale on arrival: "${span[0]}"`,
  );
});

// #1753. The comment above the setup-node step that owns `.nvmrc`'s explanation
// says Renovate moves the pin on a schedule. Read alone, that schedule looks
// like a promise about when the bump LANDS, and it never was one: the window
// bounds when the bot opens its PR, and the merge waits on the required checks
// whenever they finish. The comment now says so, and this keeps it saying so.
//
// Same rule as #348's pins above. It bans the stale FORM — a schedule named with
// nothing saying what its window bounds (the text before #1753), or a sentence
// tying the merge to the window without denying it — and accepts any paraphrase
// that states the distinction in one sentence. It pins no count and no cron
// string: the window's width and timing are renovate.json's to change, and the
// hosted app's scheduling is not observable from this tree anyway. The ceiling:
// the distinction has to sit inside ONE sentence, because a block-wide scan
// would let an unrelated "Do not hand-edit" supply the negation for a sentence
// that claims the opposite.
export function windowClaimFault(block) {
  if (!/\b(schedule|window)\b/i.test(block)) {
    return "the pin's comment no longer says the bot moves .nvmrc on a schedule — the pointer to how it moves is gone";
  }
  const bounded = block.split(/(?<=[.!?])\s+/).some((s) => {
    if (!/\b(schedule|window)\b/i.test(s)) return false;
    if (!/\b(open|opens|opened|opening|create|creates|created|creating|creation|raise|raises|raised|raising)\b/i.test(s)) return false;
    if (!/\b(PRs?|pull requests?)\b/i.test(s)) return false;
    const mergeAt = s.search(/\bmerg/i);
    if (mergeAt === -1) return false;
    // Once the sentence turns to talk about merging, "window"/"schedule" must not
    // be named again — that is the tell of a sentence that TIES the merge back to
    // the window instead of denying the tie. Without this, "whenever"/"regardless"
    // alone satisfied the negation check even in a sentence that asserts the exact
    // misreading #1753 exists to rule out, e.g. "the PR merges whenever the window
    // is open" (#1838 — reproduced by direct execution against this function).
    if (/\b(schedule|window)\b/i.test(s.slice(mergeAt))) return false;
    const NEGATION = /\b(not|never|nothing|regardless|whenever)\b|n't\b/i;
    return NEGATION.test(s.slice(0, mergeAt)) || NEGATION.test(s.slice(mergeAt));
  });
  return bounded
    ? null
    : "the pin's comment names the bot's schedule but no longer says, in one sentence, that its window bounds PR creation and not merge timing — #1753";
}

// The contiguous comment run above the setup-node step whose comment cites ADR
// 0010 — anchored on the step and the ADR it points at, never a line number.
// Exported with an optional `lines` override (same idiom as windowClaimFault's
// `block` param and citationFault's `citing`/`cited` params above) so the
// ambiguity case below can feed it synthetic input the real ci.yml does not
// contain; the production call site below takes no argument and reads the
// real file. Asserts uniqueness rather than returning the first hit: a second
// setup-node step whose comment also happens to cite "ADR 0010" would
// otherwise let this silently validate the WRONG block while the real one
// rots unchecked (#1838 — reproduced: reverting the real comment to its stale
// pre-#1753 form while an earlier decoy step's comment cited "ADR 0010" left
// every test in this file green).
export function pinOwnerComment(lines = read("../../.github/workflows/ci.yml").split("\n")) {
  const matches = [];
  for (let step = 0; step < lines.length; step++) {
    if (!/^\s*- uses: actions\/setup-node@/.test(lines[step])) continue;
    let i = step;
    while (i > 0 && /^\s*#/.test(lines[i - 1])) i--;
    const block = prose(lines.slice(i, step).join("\n"));
    if (block.includes("ADR 0010")) matches.push(block);
  }
  assert.ok(
    matches.length <= 1,
    `ci.yml has ${matches.length} setup-node comment blocks citing "ADR 0010" — the pin can no longer tell which one owns it`,
  );
  return matches[0] ?? null;
}

test("the pin's comment says the bot's window bounds PR creation, not merge timing", () => {
  const block = pinOwnerComment();
  assert.ok(block, "no setup-node step in ci.yml carries a comment pointing at ADR 0010 any more");
  assert.equal(windowClaimFault(block), null);
});

test("a paraphrase of the window claim is accepted; the stale form and a merge promise are not", () => {
  const lead = ".nvmrc holds an EXACT version, and Renovate moves it on a monthly schedule rather than a human noticing: see ADR 0010.";
  const tail = "Do not hand-edit this to float.";

  assert.equal(
    windowClaimFault(`${lead} That schedule's window bounds when the bot opens its PR, not when the PR merges. ${tail}`),
    null,
  );
  assert.equal(
    windowClaimFault(`${lead} The window only limits when Renovate raises the pull request; merging happens whenever the required checks go green. ${tail}`),
    null,
  );

  // The text as it stood before #1753: a schedule, and nothing on what it bounds.
  assert.match(windowClaimFault(`${lead} ${tail}`), /no longer says, in one sentence/);
  // The misreading stated outright — the trailing "Do not" must not rescue it.
  assert.match(windowClaimFault(`${lead} The bot opens its PR and merges it within that window. ${tail}`), /no longer says, in one sentence/);
  assert.match(windowClaimFault(`.nvmrc holds an EXACT version: see ADR 0010. ${tail}`), /no longer says the bot moves/);
});

test("windowClaimFault refuses a merge promise stated via 'whenever'/'regardless' alone (#1838)", () => {
  // Both hit every earlier condition (schedule/window, an open-class verb, PR,
  // merg, and a word from the negation class) and both assert the exact tie
  // #1753 exists to deny — this is the defect a peer review found and this
  // pins the fix.
  assert.match(
    windowClaimFault("The bot opens its PR in the window, and the PR merges whenever the window is open."),
    /no longer says, in one sentence/,
  );
  assert.match(
    windowClaimFault("The window opens the PR, and the PR merges within that window, regardless."),
    /no longer says, in one sentence/,
  );
  // The committed paraphrase that legitimately uses "whenever" still passes —
  // the fix keys off "window"/"schedule" reappearing after the merge word, not
  // off "whenever" itself.
  assert.equal(
    windowClaimFault(
      ".nvmrc holds an EXACT version, and Renovate moves it on a monthly schedule rather than a human noticing: see ADR 0010. The window only limits when Renovate raises the pull request; merging happens whenever the required checks go green. Do not hand-edit this to float.",
    ),
    null,
  );
});

test("pinOwnerComment refuses to pick silently between two setup-node comments that both cite ADR 0010 (#1838)", () => {
  const lines = [
    "      # decoy: cites ADR 0010 but is not the real pin.",
    "      - uses: actions/setup-node@v5",
    "      # the real pin, citing ADR 0010 too.",
    "      - uses: actions/setup-node@v5",
  ];
  assert.throws(() => pinOwnerComment(lines), /2 setup-node comment blocks citing "ADR 0010"/);
});
