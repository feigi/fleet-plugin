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

// A comment block cut into sentences, for the two pins below that require a
// claim and its negation to share one. A period closing an abbreviation that
// never ends a sentence — "e.g.", "i.e.", "cf.", "viz.", "vs." — is no break:
// splitting there scattered one sentence's words across two fragments, neither
// of which satisfied the pin, so a paraphrase using one was refused (#1852).
// "etc." is deliberately absent: it ends sentences as often as not, and reading
// past it would join two real sentences — the block-wide scan windowClaimFault's
// ceiling exists to forbid.
const sentences = (block) => block.split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e|cf|viz|vs)\.)\s+/i);

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
  const bounded = sentences(block).some((s) => {
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
    // "cannot" is "can not" fused, whose two-word form already passed on "not";
    // ’ is the apostrophe smart quotes type into "doesn’t" (#1852).
    const NEGATION = /\b(not|cannot|never|nothing|regardless|whenever)\b|n['’]t\b/i;
    return NEGATION.test(s.slice(0, mergeAt)) || NEGATION.test(s.slice(mergeAt));
  });
  return bounded
    ? null
    : "the pin's comment names the bot's schedule but no longer says, in one sentence, that its window bounds PR creation and not merge timing — #1753";
}

// Every setup-node step's contiguous comment run: its prose, how many comment
// lines it spans, and the job it sits in — anchored on the step, never a line
// number. A step is found by its `uses: actions/setup-node@` key wherever that
// key sits in the step, and its comment is the run above the step's own `- `
// opener, where a reader meets it (#1873). Exported with an optional `lines`
// override (same idiom as windowClaimFault's `block` param and citationFault's
// `citing`/`cited` params) so a test can feed it synthetic input the real
// ci.yml does not contain; the production call sites take no argument and read
// the real file. The owner pin and the pointer pin both read the steps through
// this, so they cannot disagree about where a step's comment starts.
export function setupNodeComments(lines = read("../../.github/workflows/ci.yml").split("\n")) {
  const found = [];
  for (let at = 0; at < lines.length; at++) {
    const uses = /^(\s*)(-\s+)?uses:\s*["']?actions\/setup-node@/.exec(lines[at]);
    if (!uses) continue;
    // `- uses:` opens its own step. Any other `uses:` belongs to the first
    // line above it that sits shallower than the key — sibling keys share its
    // column, their values sit deeper — and that line is the step's opener only
    // if it opens a sequence entry. `run: |` or `with:` there means the match
    // was never a step's own key.
    let step = at;
    if (!uses[2]) {
      const depth = uses[1].length;
      step--;
      while (step >= 0 && (/^\s*(?:#|$)/.test(lines[step]) || lines[step].search(/\S/) >= depth)) step--;
      if (step < 0 || !/^\s*-(?:\s|$)/.test(lines[step])) continue;
    }
    let i = step;
    while (i > 0 && /^\s*#/.test(lines[i - 1])) i--;
    let j = step;
    while (j > 0 && !/^ {2}[\w-]+:\s*$/.test(lines[j])) j--;
    found.push({
      block: prose(lines.slice(i, step).join("\n")),
      lines: step - i,
      job: lines[j].trim().replace(/:$/, ""),
    });
  }
  return found;
}

// The comment run above the setup-node step that owns ADR 0010's explanation.
// A candidate is a run citing "ADR 0010" over more than one line: since #1756
// every other setup-node step carries a one-line pointer to the same ADR, and
// a one-line citation is a pointer (checked by pointerFault), never a
// candidate. Asserts uniqueness among candidates rather than returning the
// first hit: a second multi-line comment that also happens to cite
// "ADR 0010" would otherwise let this silently validate the WRONG block while
// the real one rots unchecked (#1838 — reproduced: reverting the real comment
// to its stale pre-#1753 form while an earlier decoy step's comment cited
// "ADR 0010" left every test in this file green). A one-line decoy cannot
// reopen that: it is never a candidate, so the real paragraph is still the
// one checked.
export function pinOwnerComment(lines) {
  const matches = setupNodeComments(lines)
    .filter((c) => c.lines > 1 && c.block.includes("ADR 0010"))
    .map((c) => c.block);
  assert.ok(
    matches.length <= 1,
    `ci.yml has ${matches.length} setup-node comment blocks citing "ADR 0010" over more than one line — the pin can no longer tell which one owns it`,
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

test("windowClaimFault accepts a paraphrase negated by 'cannot' or a curly apostrophe, or broken by 'e.g.' (#1852)", () => {
  const lead = ".nvmrc holds an EXACT version, and Renovate moves it on a monthly schedule rather than a human noticing: see ADR 0010.";
  const tail = "Do not hand-edit this to float.";

  // Each carries its negation in exactly the form named, and nowhere else.
  assert.equal(
    windowClaimFault(`${lead} That schedule's window bounds when the bot opens its PR; it doesn’t decide when the PR merges. ${tail}`),
    null,
  );
  assert.equal(
    windowClaimFault(`${lead} The window bounds when the bot opens its PR, and it cannot hurry or delay when the PR merges. ${tail}`),
    null,
  );
  assert.equal(
    windowClaimFault(`${lead} The window bounds when the bot opens its PR (e.g. once a month), not when the PR merges. ${tail}`),
    null,
  );
});

test("a period after 'etc.' still ends the sentence, so the next one's negation cannot rescue a merge promise (#1852)", () => {
  // Read as one sentence this is accepted — the trailing "Do not" supplies the
  // negation. "etc." ends sentences as often as not, so it is no abbreviation
  // the splitter may skip: skipping it is the block-wide scan the ceiling bans.
  assert.match(
    windowClaimFault("In the window the bot opens its PR and merges it, etc. Do not hand-edit this to float."),
    /no longer says, in one sentence/,
  );
});

test("windowClaimFault's splitter skips every listed abbreviation, not only 'e.g.' (#1852)", () => {
  const lead = ".nvmrc holds an EXACT version, and Renovate moves it on a monthly schedule rather than a human noticing: see ADR 0010.";
  const tail = "Do not hand-edit this to float.";
  for (const abbr of ["i.e.", "cf.", "viz.", "vs."]) {
    assert.equal(
      windowClaimFault(`${lead} The window bounds when the bot opens its PR (${abbr} once a month), not when the PR merges. ${tail}`),
      null,
      `${abbr} should not split the sentence`,
    );
  }
});

test("windowClaimFault still splits after a word that only ends in an abbreviation's letters (#1852)", () => {
  // "devs." is not "vs." — the lookbehind's `\b` anchors the abbreviation to a
  // whole word, or a period after any word ending in these letters would
  // silently stop splitting there, joining two real sentences.
  assert.match(
    windowClaimFault("In the window the bot opens its PR and merges it for the devs. Do not hand-edit this to float."),
    /no longer says, in one sentence/,
  );
});

test("windowClaimFault still refuses a negation spelled with the opening curly quote — only U+2019 is accepted (#1852)", () => {
  // U+2018 is what smart-quote engines use to OPEN a single-quoted span, never
  // inside a contraction, so a paraphrase relying on it for "doesn't" is not one.
  assert.match(
    windowClaimFault(
      ".nvmrc holds an EXACT version, and Renovate moves it on a monthly schedule rather than a human noticing: see ADR 0010. That schedule’s window bounds when the bot opens its PR; it doesn\u2018t decide when the PR merges. Do not hand-edit this to float.",
    ),
    /no longer says, in one sentence/,
  );
});

test("pinOwnerComment refuses to pick silently between two setup-node comments that both cite ADR 0010 (#1838)", () => {
  const lines = [
    "      # decoy: cites ADR 0010 but is not the real pin,",
    "      # over two lines like the real one.",
    "      - uses: actions/setup-node@v5",
    "      # the real pin, citing ADR 0010 too,",
    "      # over two lines.",
    "      - uses: actions/setup-node@v5",
  ];
  assert.throws(() => pinOwnerComment(lines), /2 setup-node comment blocks citing "ADR 0010"/);
});

// #1838's exploit, re-run against the pointer rule: a one-line citation of
// ADR 0010 at an earlier step, then the real paragraph reverted to its stale
// pre-#1753 form. The pointer is not a candidate, so the stale paragraph is
// the block checked, and it still reds.
test("a one-line pointer citing ADR 0010 is never taken for the owner (#1756)", () => {
  const lines = [
    "      # Exact pin Renovate moves: see ADR 0010. Do not hand-edit this to float.",
    "      - uses: actions/setup-node@v5",
    "      # .nvmrc holds an EXACT version, and Renovate moves it on a monthly",
    "      # schedule rather than a human noticing: see ADR 0010. Do not hand-edit",
    "      # this to float.",
    "      - uses: actions/setup-node@v5",
  ];
  const owner = pinOwnerComment(lines);
  assert.match(owner, /monthly schedule rather than a human noticing/);
  assert.match(windowClaimFault(owner), /no longer says, in one sentence/);
});

// #1756. Only the owner's comment named ADR 0010 and the do-not-hand-edit
// rule, so a reader who opened ci.yml at any other setup-node step met no
// warning at all. Each of those steps now carries a one-line pointer to both.
// One line is the FORM being pinned, not a figure: a copied paragraph is two
// copies of one rule, the drift workflow-files.mjs's header names for a
// discovery rule. Same rule as #348's pins — it bans the stale forms (a
// step with no pointer, a pointer missing the ADR or the rule, a pointer grown
// into a paragraph) and accepts any paraphrase. It pins no count of steps:
// adding or dropping a Node-setup site needs no edit here. The rule and its
// negation must share a sentence, for the reason windowClaimFault gives, AND
// sit within six words of "hand-edit" itself — co-occurrence anywhere in the
// sentence is not enough, because "Hand-edit this pin whenever convenient;
// there is no rule against it." shares a sentence with a negation that never
// touches the verb it is supposed to forbid (reproduced: that exact wording,
// and "Renovate no longer manages this on its own — hand-edit if it drifts.",
// both passed here undetected until the word-window check was added). The
// ceiling: an unrelated comment run directly above a pointer makes it a
// multi-line citation, a second candidate owner that pinOwnerComment refuses
// loudly; a blank line between the two keeps the pointer its own run.
export function pointerFault({ block, lines }) {
  if (lines === 0) return "carries no comment at all — no pointer to ADR 0010 or the do-not-hand-edit rule";
  if (!block.includes("ADR 0010")) return "no longer points at ADR 0010";
  const rule = sentences(block).some((s) => {
    const m = /hand-?edit\w*/i.exec(s);
    if (!m) return false;
    const tokens = s.split(/\s+/);
    let pos = 0;
    let idx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (m.index >= pos && m.index < pos + tokens[i].length + 1) {
        idx = i;
        break;
      }
      pos += tokens[i].length + 1;
    }
    if (idx === -1) return false;
    const WINDOW = 6;
    const nearby = tokens.slice(Math.max(0, idx - WINDOW), idx + WINDOW + 1).join(" ");
    // cannot and the curly apostrophe — the two forms this fix adds — match
    // windowClaimFault's NEGATION too (#1852); the two functions' negation
    // word lists otherwise differ intentionally (this one also accepts "no").
    return /\b(?:not|cannot|never|no)\b/i.test(nearby) || /n['’]t\b/i.test(nearby);
  });
  if (!rule) return "no longer carries the do-not-hand-edit rule";
  if (lines > 1) return "has grown past one line — a pointer that copies the owner's paragraph is the drift it exists to avoid";
  return null;
}

test("every setup-node step but the owner points at ADR 0010 and the do-not-hand-edit rule in one line", () => {
  const owner = pinOwnerComment();
  for (const c of setupNodeComments().filter((c) => c.block !== owner)) {
    const fault = pointerFault(c);
    assert.equal(fault, null, `the setup-node step in ci.yml's \`${c.job}\` job ${fault}`);
  }
});

// #1873. A setup-node step whose `- ` opener is another key — `- name:` above
// its `uses:`, a shape other steps in ci.yml already take — was never
// discovered, so every pin reading steps through setupNodeComments was blind
// to it: such a step with no pointer at all passed every test here. A reader
// meets the step's comment above its opener, not above `uses:`, so that is
// where the run is read.
test("a setup-node step opened by another key is discovered, its comment read above that opener (#1873)", () => {
  const pointer = "      # Exact pin Renovate moves: see ADR 0010. Do not hand-edit this to float.";
  const named = ["      - name: Set up Node", "        uses: actions/setup-node@v5"];

  // The ticket's own repro: no comment, and the step used to come back unseen.
  assert.deepEqual(setupNodeComments(["  job:", ...named]), [{ block: "", lines: 0, job: "job" }]);
  assert.match(pointerFault(setupNodeComments(["  job:", ...named])[0]), /no comment at all/);

  // What the wider match must still ACCEPT: a pointer above the opener, with
  // sibling keys, a nested value or a quoted scalar anywhere in between.
  for (const step of [
    named,
    ["      - id: node", "        with:", "          node-version-file: .nvmrc", "        uses: 'actions/setup-node@v5'"],
    ['      - uses: "actions/setup-node@v5"'],
  ]) {
    const found = setupNodeComments(["  job:", pointer, ...step]);
    assert.deepEqual(found, [{ block: pointer.replace(/^\s*#\s?/, ""), lines: 1, job: "job" }], step.join("\n"));
    assert.equal(pointerFault(found[0]), null);
  }
});

// #1838's exploit through the same gap: with the real owner refactored into a
// named step, a bare-form decoy was the only candidate pinOwnerComment could
// see, so it validated the decoy while the real paragraph rotted unchecked.
test("pinOwnerComment sees an owner written as a named step, so a bare-form decoy cannot stand in for it (#1873)", () => {
  const owner = [
    "      # .nvmrc holds an EXACT version, and Renovate moves it on a monthly",
    "      # schedule: see ADR 0010. Do not hand-edit this to float.",
    "      - id: node",
    "        with:",
    "          node-version-file: .nvmrc",
    "        uses: actions/setup-node@v5",
  ];
  const decoy = [
    "      # decoy: cites ADR 0010 but is not the real pin,",
    "      # over two lines like the real one.",
    "      - uses: actions/setup-node@v5",
  ];
  assert.match(pinOwnerComment(owner), /monthly schedule: see ADR 0010/);
  assert.throws(() => pinOwnerComment([...decoy, ...owner]), /2 setup-node comment blocks citing "ADR 0010"/);
});

// The wider match's own false-positive class: a `uses:` line is a step only
// when the first shallower line above it opens a sequence entry. Inside a
// `run:` script or under `with:` it is not, and a phantom step there would red
// the pointer test over a step that does not exist.
test("a `uses: actions/setup-node@` line that is not a step's own key is not taken for a step (#1873)", () => {
  const scripted = ["      - name: Print an example", "        run: |", "          uses: actions/setup-node@v5"];
  const nested = ["      - uses: some/action@v1", "        with:", "          uses: actions/setup-node@v5"];
  assert.deepEqual(setupNodeComments(["  job:", ...scripted]), []);
  assert.deepEqual(setupNodeComments(["  job:", ...nested]), []);
});

test("a paraphrased pointer is accepted; a missing one, a half one and a copied paragraph are not", () => {
  const at = (...comment) => setupNodeComments(["  job:", ...comment, "      - uses: actions/setup-node@v5"])[0];

  assert.equal(pointerFault(at("      # Exact pin Renovate moves: see ADR 0010. Do not hand-edit this to float.")), null);
  assert.equal(pointerFault(at("      # .nvmrc is exact and bot-moved (ADR 0010); never hand-edit it to float.")), null);
  assert.equal(pointerFault(at("      # Hand-editing this to float is not allowed: ADR 0010 explains why.")), null);

  assert.match(pointerFault(at()), /no comment at all/);
  assert.match(pointerFault(at("      # Exact pin Renovate moves. Do not hand-edit this to float.")), /no longer points at ADR 0010/);
  assert.match(pointerFault(at("      # Exact pin Renovate moves: see ADR 0010.")), /do-not-hand-edit rule/);
  assert.match(
    pointerFault(at("      # Hand-edit this freely. See ADR 0010; it does not apply here.")),
    /do-not-hand-edit rule/,
  );
  assert.match(
    pointerFault(
      at(
        "      # .nvmrc holds an EXACT version, and Renovate moves it on a monthly",
        "      # schedule: see ADR 0010. Do not hand-edit this to float.",
      ),
    ),
    /grown past one line/,
  );
});

test("a negation sharing hand-edit's sentence but not touching it is still a missing rule (#1868)", () => {
  const at = (...comment) => setupNodeComments(["  job:", ...comment, "      - uses: actions/setup-node@v5"])[0];

  assert.match(
    pointerFault(at("      # Hand-edit this pin whenever convenient; there is no rule against it. See ADR 0010.")),
    /do-not-hand-edit rule/,
  );
  assert.match(
    pointerFault(at("      # Renovate no longer manages this on its own — hand-edit if it drifts. See ADR 0010.")),
    /do-not-hand-edit rule/,
  );
});

test("pointerFault accepts a rule negated by 'cannot' or a curly apostrophe, or broken by 'e.g.' (#1852)", () => {
  const at = (...comment) => setupNodeComments(["  job:", ...comment, "      - uses: actions/setup-node@v5"])[0];

  assert.equal(pointerFault(at("      # .nvmrc is exact and bot-moved (ADR 0010); it cannot be hand-edited to float.")), null);
  assert.equal(pointerFault(at("      # Exact pin Renovate moves: see ADR 0010. Don’t hand-edit this to float.")), null);
  assert.equal(pointerFault(at("      # Never, e.g. for a patch, hand-edit this pin: see ADR 0010.")), null);
});

test("pointerFault still refuses a rule spelled with the opening curly quote — only U+2019 is accepted (#1852)", () => {
  const at = (...comment) => setupNodeComments(["  job:", ...comment, "      - uses: actions/setup-node@v5"])[0];
  assert.match(
    pointerFault(at("      # Exact pin Renovate moves: see ADR 0010. Don\u2018t hand-edit this to float.")),
    /no longer carries the do-not-hand-edit rule/,
  );
});

// #1903. The Validate JSON step's comment opened "Exactly two tracked JSON
// files, both plugin manifests" and named the two. True the day it was written
// (3f9dd372, the 2026-09-08 config split); five more tracked `*.json` files
// landed over the following two-plus weeks and the sentence stayed, because
// nothing reads it — the step parses whatever `git ls-files '*.json'` returns.
// The shape #348 fixed in the Shellcheck comment: prose measuring a set the
// comment does not own.
//
// Same rule as #348's pins: the FORM is banned and no number is pinned, so a
// JSON file added or removed needs no edit here. The form is a count sizing the
// files — a digit, a spelled-out number two and up (through the nineties, plus
// "dozen"), or "both" — with at most two words between it and "files" or
// "manifests", none of them ending a sentence. A word ENDING in a period is the
// sentence end; one merely containing a period is a file name — "seven tracked
// `*.json` files" is the count, not a boundary. Plural nouns only, because the
// jq rationale in the same block says the step "exits 1 on a file holding
// `null`": a singular noun would read that exit status as a count. That is the
// ceiling as well — "exactly one tracked JSON file" passes, and so does a bare
// list of paths with no count in front of it. The block is the contiguous
// comment run above the step, anchored on the step's name like the failglob
// pin, so a count moved into another step's comment is outside it.
const JSON_COUNT =
  /\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty(?:[- ]?(?:one|two|three|four|five|six|seven|eight|nine))?|dozen|both)\s+(?:\S*[^\s.!?]\s+){0,2}?(?:files|manifests)\b/i;

export function jsonCountFault(block) {
  // The positive half, scoped to the block's FIRST sentence only. A
  // doesNotMatch over the WHOLE block is vacuous: this block's own cache
  // sentence ("gitignored, so `git ls-files` never sees them") also contains
  // `git ls-files`, so a stale count reintroduced as its OWN paragraph and
  // split from the rest by a blank line — which the walk below (the same
  // "blank line ends the comment run" rule the failglob pin and every other
  // block-walk in this file already use) treats as ending the step's comment
  // right there — would still leave a slice whose only surviving coverage
  // word is that unrelated cache sentence, reading as covered while the
  // actual coverage claim, and the count sitting above it, are both gone from
  // what this function ever sees. The real coverage sentence leads the
  // paragraph in the current wording, and every accepted paraphrase below
  // does too — measured against `sentences()`, not a raw substring search.
  const lead = sentences(block)[0] ?? "";
  if (!/\btracked\b|git ls-files/.test(lead)) {
    return "the Validate JSON comment no longer says which files the step parses — the slice this pin reads has lost its coverage paragraph";
  }
  const count = JSON_COUNT.exec(block);
  return count
    ? `the Validate JSON comment sizes the tracked JSON set again ("${count[0]}") — a count there goes stale the next time a JSON file is added (#1903)`
    : null;
}

test("the Validate JSON comment says which files it parses without counting them (#1903)", () => {
  const lines = read("../../.github/workflows/ci.yml").split("\n");
  const step = lines.findIndex((l) => /^\s*- name: Validate JSON$/.test(l));
  assert.ok(step >= 0, "ci.yml no longer has a Validate JSON step");
  let i = step;
  while (/^\s*#/.test(lines[i - 1])) i--;
  assert.equal(jsonCountFault(prose(lines.slice(i, step).join("\n"))), null);
});

test("jsonCountFault refuses a count of the JSON files in any spelling, and a slice without its coverage paragraph (#1903)", () => {
  const jq = "`jq empty`, not `jq -e .`: it exits 1 on a file holding `null` or `false` — both valid JSON.";
  for (const count of [
    "Exactly two tracked JSON files, both plugin manifests: plugin/.claude-plugin/plugin.json and .claude-plugin/marketplace.json.",
    "Every tracked JSON file — seven tracked `*.json` files at the time of writing.",
    "Parses the 7 JSON files `git ls-files` lists.",
    "Parses what `git ls-files` lists, both plugin manifests among them.",
    "A dozen tracked JSON files exist today.",
    "Thirteen tracked JSON files, at last count.",
    "Twenty-one files are tracked as JSON today.",
  ]) {
    assert.match(jsonCountFault(`${count} ${jq}`), /sizes the tracked JSON set again/, count);
  }
  assert.match(jsonCountFault(jq), /no longer says which files the step parses/);
});

test("jsonCountFault accepts the block's own non-counting numbers and a count cut off by a sentence end (#1903)", () => {
  const jq = "`jq empty`, not `jq -e .`: it exits 1 on a file holding `null` or `false` — both valid JSON.";
  const cache = "The runtime caches are NOT covered — every one of them is gitignored, so `git ls-files` never sees them.";
  assert.equal(jsonCountFault(`Parses every file \`git ls-files '*.json'\` lists. ${cache} ${jq}`), null);
  assert.equal(jsonCountFault(`Every tracked \`*.json\` file. The 2026-09-08 split removed two of them. Files added since need no edit here. ${jq}`), null);
});

// Review of PR #1942 (correctness + tests dimensions, independently
// corroborated 3 ways): the doesNotMatch above used to scan the WHOLE block,
// so a stale count reintroduced as its own paragraph and separated from the
// rest by a blank line survived undetected — the walk that slices the real
// ci.yml file stops at that blank line (same rule every block-walk in this
// file already follows), dropping the count-bearing line entirely, while the
// truncated remainder still contained the cache sentence's OWN `git ls-files`
// mention and satisfied the coverage check on that alone. Measured before the
// fix: this exact input returned `null`. Pinned here as a unit test on
// `jsonCountFault` directly, since the walk itself is correct per this file's
// own convention — the bug was in what the coverage check was willing to
// accept as evidence, not in where the block boundary falls.
test("jsonCountFault still refuses a count parked in its own paragraph, split from the rest by a blank line the walk already treats as the block boundary (#1903 follow-up)", () => {
  const jq = "`jq empty`, not `jq -e .`: it exits 1 on a file holding `null` or `false` — both valid JSON.";
  const remainderAfterBlankLineSplit =
    "No count and no list of them, on purpose: the count this comment used to carry went stale as files were added (#1903), and ci-comment-rot-prose.test.mjs refuses one coming back. The runtime caches are NOT covered and cannot be — every one of them is gitignored, so `git ls-files` never sees them. Do not read this step as saying anything about a cache. " +
    jq;
  assert.match(jsonCountFault(remainderAfterBlankLineSplit), /no longer says which files the step parses/);
});
