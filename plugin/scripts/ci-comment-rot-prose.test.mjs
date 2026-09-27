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
import { sentences } from "./prose-pin.mjs";

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
  // stands in front of a misquote and absorbs the whole check.
  //
  // The sentence runs from the name to its real end as sentences() finds it,
  // never to the first period: "e.g.", "ci.yml" and a period inside the
  // quotation itself each came before the quoted span, cut the sentence short
  // of it, and let a misquote read as a paraphrase (#1898). Quoted spans are
  // blanked to same-length filler before splitting — straight quotes are
  // assumed to come in proper, non-empty pairs; a stray unpaired `"` or an
  // empty `""` shifts that pairing instead of closing it, a masking gap this
  // function doesn't guard (tracked separately, #1962) — so a period inside a
  // PROPERLY PAIRED quotation can't end the sentence, and the cut lands at
  // the same offset in the real text.
  // That holds for a quotation's closing period too (`…out." Next`): the
  // sentence then runs on to the next real end, which can only add spans to
  // check — the loud direction. Ending it at the closing mark instead would
  // also end `says "…out." and adds "…"` before its second quotation, unread.
  // Parenthesized spans are blanked the same way, after the quoted ones: since
  // #1940 sentences() ends a sentence at a closing mark behind a terminator, so
  // a whole sentence in parentheses between the name and its quotation
  // (`claim-ticket.sh (as it says.) says "…"`) would otherwise end the citing
  // sentence at its `.)` and hide the quotation — the short direction here.
  // A bold `.**`, an underscore-italic `._`, or a single-quoted `.'` still
  // ends it unblanked: ci.yml's comments are not markdown, and a straight
  // single quote there is an apostrophe as often as not, so neither is a
  // reliably paired delimiter worth chasing. Curly quotes ARE reliably
  // paired (an opener and a closer are different characters, unlike a
  // straight quote or `*`/`_`), so they get the same blanking as a straight
  // quotation — left out of a first pass here would have been the same
  // silent gap the parenthesis fix above closes, just spelled `.”`/`.’`.
  // The early return above is what keeps indexOf off -1.
  const from = citing.slice(citing.indexOf("claim-ticket.sh"));
  const blankQuotes = (s) =>
    s
      .replace(/"[^"]+"/g, (span) => `"${"x".repeat(span.length - 2)}"`)
      .replace(/\u201c[^\u201d]+\u201d/g, (span) => `\u201c${"x".repeat(span.length - 2)}\u201d`)
      .replace(/\u2018[^\u2019]+\u2019/g, (span) => `\u2018${"x".repeat(span.length - 2)}\u2019`);
  const blankParens = (s) => {
    let depth = 0;
    return [...s]
      .map((ch) => {
        if (ch === "(") return depth++, ch;
        if (ch === ")") return (depth = Math.max(depth - 1, 0)), ch;
        return depth > 0 ? "x" : ch;
      })
      .join("");
  };
  // A single regex pass (`/\([^()]*\)/g`) only strips the INNERMOST paren:
  // nested parens (`(as it says itself (in section 2).)`) leave the outer
  // `)` — and the real period right before it — untouched, so the outer
  // `.)` still ends the sentence early and hides a misquote past it
  // (measured: a regex pass here let a misquote inside a nested aside read
  // as a paraphrase). `blankParens` tracks depth across the WHOLE string
  // instead: every character between any `(` and its matching `)` is
  // blanked regardless of nesting, while depth returns to 0 between two
  // SEPARATE (non-nested) parenthetical asides, so real prose sitting
  // between them is not swept in with them.
  const opaque = blankParens(blankQuotes(from));
  const sentence = from.slice(0, sentences(opaque)[0].length);
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

// #1898. The citing sentence used to end at the FIRST period after the name, so
// a period that ends no sentence cut it short of its quotation: an abbreviation
// ("e.g.", or any other sentences() skips), a period inside a word ("ci.yml",
// "v1.2"), or a period inside the quoted span itself. The quotation then fell
// outside the sentence, and the misquote read as a paraphrase — the silent
// direction. Each input below is the misquote the test above refuses.
test("an abbreviation sentences() exempts, mid-word, in-quotation, or quote/paren-closing period cannot hide a misquote from citationFault (#1898)", () => {
  const cited = "so this walk, not node, is what keeps vendored tests out.";

  for (const abbr of ["e.g.", "i.e.", "cf.", "viz.", "vs."]) {
    assert.match(
      citationFault(`claim-ticket.sh says, ${abbr} "this filter, not node"`, cited),
      /does not say it/,
      `${abbr} ended the citing sentence before its quotation`,
    );
  }
  assert.match(citationFault('claim-ticket.sh, unlike ci.yml (v1.2), says "this filter, not node"', cited), /does not say it/);
  assert.match(citationFault('claim-ticket.sh says "this filter. Not node"', cited), /does not say it/);
  assert.match(citationFault('claim-ticket.sh says "this filter, not node."', cited), /does not say it/);
  // A quotation's own closing period is not a stop either: an implementation that
  // ended the sentence right there — reasonable-looking, since the quote already
  // carries its own terminator — would silently let a second, misquoted span right
  // after it hide as though it were the next sentence this function's own comment
  // says it may not answer for (verified: such an implementation passes every
  // other assertion in this file and still accepts this one).
  assert.match(
    citationFault('claim-ticket.sh says "is what keeps vendored tests out." and adds "this filter, not node"', cited),
    /does not say it/,
  );
  // #1940: sentences() now ends a sentence at `.)`, so a whole sentence in
  // parentheses ahead of the quotation is a stop unless it is blanked too.
  assert.match(citationFault('claim-ticket.sh (as it says itself.) says "this filter, not node"', cited), /does not say it/);
  // A NESTED parenthetical, one level deep: a single un-repeated blanking pass
  // strips only the inner `(in section 2)`, leaving the outer `.)` — a real,
  // now-unblanked terminator-plus-closing-mark — to end the sentence early and
  // hide the quotation past it exactly as the unnested case above would without
  // any blanking at all.
  assert.match(
    citationFault('claim-ticket.sh (as it says itself (in section 2).) says "this filter, not node"', cited),
    /does not say it/,
  );
  // Curly quotes are a reliably paired delimiter too (opener and closer are
  // different characters), so an aside set off by them gets the same
  // protection as one set off by straight quotes or parens — a `.”`/`.’`
  // ahead of the real quotation must not cut the sentence short either.
  assert.match(
    citationFault('claim-ticket.sh \u201cas it says itself.\u201d says "this filter, not node"', cited),
    /does not say it/,
  );
  assert.match(
    citationFault('claim-ticket.sh \u2018as it says itself.\u2019 says "this filter, not node"', cited),
    /does not say it/,
  );
  // Deliberately NOT tested here: a NON-EXEMPT abbreviation ("etc.", or any
  // other word ending in a period sentences() does not name — the exempt
  // list is fixed, not "abbreviation" in general), a SPACED abbreviation
  // ("e. g." — the space keeps sentences() from ever matching the "e.g" it
  // exempts), a mid-sentence ellipsis ("..." — its own last period is a
  // real, unexempted terminator), and a misquote reachable only via a
  // SECOND, separate mention of claim-ticket.sh (out of scope regardless of
  // sentences(): this function only ever reads the first sentence). Each
  // still lets a misquote read as a paraphrase; none is a regression, and
  // none is a form #1898's own remedy promised to close.
});

// The other half of #1898: the sentence still ends at its REAL end. Once
// sentences() actually lands a boundary there, a quoted span past it is not
// claim-ticket.sh's to answer for — reading on past the end is the unbounded
// scan citationFault's own comment forbids — and a true quotation reached
// across "e.g.", or carrying its own period, still passes. A quotation's own
// closing period is not that boundary, though: the previous test pins the
// loud direction that falls out when it stands in for one instead.
test("citationFault reads past 'e.g.' but not past the sentence's end (#1898)", () => {
  const cited = "so this walk, not node, is what keeps vendored tests out.";

  assert.equal(citationFault('see claim-ticket.sh, e.g. "walk, not node"', cited), null);
  assert.equal(citationFault('claim-ticket.sh says "is what keeps vendored tests out."', cited), null);
  assert.equal(
    citationFault('claim-ticket.sh makes the same point, e.g. about its own walk. The runner\'s "find" was the defect.', cited),
    null,
  );
  // #1898: sentences() already ends a sentence at a bare `?` or `!`, not
  // only at `.` — see its own comment in prose-pin.mjs (where #1940 later
  // moved this shared definition) for why that swaps which direction is
  // silent for a checker like this one. A quote past either is just as
  // unanswerable as one past a period.
  assert.equal(
    citationFault('Does claim-ticket.sh agree? It says "this filter, not node".', cited),
    null,
  );
  assert.equal(
    citationFault('claim-ticket.sh agrees! It also says "this filter, not node".', cited),
    null,
  );
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
// whenever they finish — a major's on a human too, which majorMergeFault holds
// the comment to. The comment now says so, and this keeps it saying so.
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

// The indices of `lines` that are a block scalar's content (#1975): after a
// `key: |` or `- >-` header — chomping and indentation indicators, an anchor
// or tag, a quoted key and a trailing comment allowed — every line up to the
// first non-blank one set shallower than the content. The content's column
// is the header's indentation indicator past the column of its key (of its
// dash, for a bare `- |`, or of the document itself for a bare `--- |`), or
// else the first non-blank line's own, which must sit deeper than that
// column or the scalar is empty. A line in there is text however it is
// spelled, so a header inside it opens nothing. Only block scalars: a quoted
// or plain scalar can span lines too, but none in ci.yml does, and at a
// step's depth the job check below refuses any step such a string could
// spell — that check has no equivalent for the comment-run walk, so a
// multi-line quoted or plain scalar can still lend the wrong text to a
// step's comment; ci.yml has no such scalar today, so this is a documented,
// latent gap, not a live one (#2000).
//
// Two header shapes #1975 left undetected (#2000). The plain-key
// alternative used to exclude `#` outright; YAML only starts a comment at
// whitespace-then-`#`, so it now excludes `#` only when whitespace precedes
// it, letting a plain key contain one (`C#: |`). And a document-start
// marker (`--- |`) opens a scalar with no key at all — its own production,
// column −1, since the content it owns need only sit deeper than the
// document itself, never as shallow as a real job or key.
function blockScalarText(lines) {
  const text = new Set();
  for (let at = 0; at < lines.length; at++) {
    const header =
      /^(\s*(?:-\s+)*)((?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#"'](?:[^#]|(?<!\s)#)*?)\s*:\s+)?(?:[&!]\S*\s+)*[|>]([1-9])?[-+]?([1-9])?\s*(?:#.*)?$/.exec(
        lines[at],
      );
    const docHeader =
      !header && /^---\s+(?:[&!]\S*\s+)*[|>]([1-9])?[-+]?([1-9])?\s*(?:#.*)?$/.exec(lines[at]);
    if (!header && !docHeader) continue;
    if (header && !header[2] && !header[1].includes("-")) continue;
    const column = docHeader ? -1 : header[2] ? header[1].length : header[1].trimEnd().length - 1;
    const indicator = Number((docHeader ? docHeader[1] : header[3]) ?? (docHeader ? docHeader[2] : header[4]) ?? 0);
    let depth = indicator ? column + indicator : null;
    let end = at + 1;
    for (; end < lines.length; end++) {
      if (/^\s*$/.test(lines[end])) continue;
      // A document marker (`---`/`...`) always ends the current document —
      // and any scalar still open in it — under both YAML 1.1 and 1.2.
      // Without this, a document-start scalar's own indentation indicator
      // of exactly 1 sets `depth` to 0 (column −1 plus indicator 1), a floor
      // no real line's column can ever go under, so the scalar never closes
      // and swallows the rest of the file — silently dropping every step in
      // a later document. Found in review of #2005 (`--- |1` followed by a
      // second document holding a real step); ci.yml has neither a document
      // marker nor an explicit indentation indicator today, so this was
      // unreachable there, but the production this file emits for `--- |1`
      // should still match PyYAML rather than trust a floor that can go
      // non-positive.
      if (/^(?:---|\.\.\.)(?:\s|$)/.test(lines[end])) break;
      const col = lines[end].search(/\S/);
      depth ??= col;
      if (col < depth || col <= column) break;
    }
    for (let k = at + 1; k < end; k++) text.add(k);
    at = end - 1;
  }
  return text;
}

// Every setup-node step's contiguous comment run: its prose, how many comment
// lines it spans, and the job it sits in — anchored on the step, never a line
// number. A step is an entry of `steps:`, found by its
// `uses: actions/setup-node@` key wherever that key sits among the entry's own
// keys, and its comment is the run directly above the step's own `- ` opener,
// where a reader meets it (#1873) — a blank line ends that run, the opener's
// side included, so a comment with a blank line under it is not the step's
// (#1919). A block scalar's content is neither a step's key nor a comment,
// and a key read by name here may be quoted or spaced from its colon, as YAML
// allows (#1975). A `uses:` key's colon must still be followed by real
// whitespace — YAML's own rule for telling a key from a plain scalar that
// merely contains one (`uses:actions/…` is the latter, never a key) — and
// either a job's own key or a `uses:` key may carry an anchor or tag between
// its colon and its value, as YAML allows there too (#2000) — including the
// bare `!` non-specific tag, which has no characters of its own to require
// (found in review of #2005: `\S+` after `[&!]` refused it where the header
// regex above already used `\S*`). Exported with
// an optional `lines` override (same idiom as windowClaimFault's `block`
// param and citationFault's `citing`/`cited` params) so a test can feed it
// synthetic input the real ci.yml does not contain; the production call
// sites take no argument and read the real file. The owner pin and the
// pointer pin both read the steps through this, so they cannot disagree
// about where a step's comment starts.
export function setupNodeComments(lines = read("../../.github/workflows/ci.yml").split("\n")) {
  const text = blockScalarText(lines);
  const found = [];
  for (let at = 0; at < lines.length; at++) {
    const uses = /^(\s*)(-\s+)?(["']?)uses\3\s*:\s+(?:[&!]\S*\s+)*["']?actions\/setup-node@/.exec(lines[at]);
    if (!uses || text.has(at)) continue;
    // `- uses:` opens its entry. Any other `uses:` belongs to the first line
    // above it that sits shallower than the key — sibling keys share its
    // column, their values sit deeper — and that line is the entry's opener
    // only if it opens a sequence entry whose own keys start at `uses:`'s
    // column. `with:` there, on a line of its own or after the `- `, means
    // the match was never an entry's own key. A bare `-`, or a
    // dash whose only remainder is a comment, sets its keys under it, each of
    // which the walk has already held at or past that column (#1920 follow-up:
    // a trailing comment's own text is not a key, so it must not set the
    // column the way a real key would).
    let step = at;
    if (!uses[2]) {
      const depth = uses[1].length;
      step--;
      while (step >= 0 && (/^\s*(?:#|$)/.test(lines[step]) || lines[step].search(/\S/) >= depth)) step--;
      if (step < 0) continue;
      if (!/^\s*-\s*(?:#.*)?$/.test(lines[step]) && /^\s*-\s+(?=\S)/.exec(lines[step])?.[0].length !== depth) continue;
    }
    // Either way the entry is a step only if it hangs from `steps:`: the first
    // line above the opener that neither sits deeper than its `- ` nor opens a
    // sibling entry level with it. A list nested in `with:` or a matrix
    // `include:` has entries shaped exactly like a step's (#1920).
    const dash = lines[step].search(/\S/);
    let parent = step - 1;
    for (; parent >= 0; parent--) {
      if (/^\s*(?:#|$)/.test(lines[parent])) continue;
      const col = lines[parent].search(/\S/);
      if (col < dash || (col === dash && !/^\s*-(?:\s|$)/.test(lines[parent]))) break;
    }
    if (parent < 0 || !/^\s*(["']?)steps\1\s*:(?:\s|$)/.test(lines[parent])) continue;
    // `steps:` is just a key spelled that way — nothing above checks that it
    // sits directly under a job, not inside some action's own config that
    // happens to reuse the name. The line immediately shallower than it, if
    // the walk finds one before running off the top, must open a job
    // (`  name:`, quoted or not, a comment after it allowed); anything else —
    // another `with:`, a matrix `include:` — means this `steps:` is not the
    // job's (#1920 follow-up). That line names the job.
    const stepsDepth = lines[parent].search(/\S/);
    let jobLine = parent - 1;
    while (jobLine >= 0 && (/^\s*(?:#|$)/.test(lines[jobLine]) || lines[jobLine].search(/\S/) >= stepsDepth)) jobLine--;
    const jobKey = jobLine >= 0 ? /^ {2}(["']?)([\w-]+)\1\s*:\s*(?:[&!]\S*\s*)*(?:#.*)?$/.exec(lines[jobLine]) : null;
    if (jobLine >= 0 && !jobKey) continue;
    let i = step;
    while (i > 0 && /^\s*#/.test(lines[i - 1]) && !text.has(i - 1)) i--;
    found.push({
      block: prose(lines.slice(i, step).join("\n")),
      lines: step - i,
      job: jobKey?.[2] ?? null,
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

// #1956. The same comment's merge clause said the merge waits on the required
// checks, whenever they finish — written by #1753 as if the checks alone gate
// every bump, when #1752 had already narrowed that: renovate.json's `major`
// rule sets `automerge: false`, so a major bump's merge waits on a human as
// well. ADR 0010 point 3 took the same narrowing in #1906. This bans the
// unscoped form: a sentence that ties the merge to the checks must name both
// the major and the human it waits on, inside that sentence, for the reason
// windowClaimFault gives for its ceiling — read any wider, the lead's "rather
// than a human noticing" supplies the human for a merge clause that never
// mentions one. The ceiling's cost: a paraphrase stating the exception only
// in the NEXT sentence reds too. It pins the exception's presence, not its
// polarity — "a major merges without a human" names both and passes — and no
// update-type list: which types automerge is renovate.json's to say, and
// renovate-release-contract.test.mjs already reds a major that automerges.
export function majorMergeFault(block) {
  const unscoped = sentences(block).find(
    (s) =>
      /\b(?:auto-?)?merg/i.test(s) &&
      /\b(checks?|CI|green)\b/i.test(s) &&
      !(/\bmajors?\b/i.test(s) && /\b(humans?|maintainers?|manual(?:ly)?|by hand)\b/i.test(s)),
  );
  return unscoped === undefined
    ? null
    : `the pin's comment ties the merge to the checks without saying, in that sentence, that a major bump's merge waits on a human too — #1956: "${unscoped}"`;
}

test("the pin's comment says a major bump's merge waits on a human, not on the checks alone (#1956)", () => {
  const block = pinOwnerComment();
  assert.ok(block, "no setup-node step in ci.yml carries a comment pointing at ADR 0010 any more");
  assert.equal(majorMergeFault(block), null);
});

test("majorMergeFault accepts a scoped merge clause or none; an unscoped one, or one scoped only in the next sentence, is refused (#1956)", () => {
  const lead = ".nvmrc holds an EXACT version, and Renovate moves it on a monthly schedule rather than a human noticing: see ADR 0010.";
  const tail = "Do not hand-edit this to float.";
  const window = "That schedule's window bounds when the bot opens its PR, not when the PR merges";

  assert.equal(majorMergeFault(`${lead} ${window}: the merge waits on the required checks, whenever they finish, and a major bump's waits on a human too. ${tail}`), null);
  assert.equal(majorMergeFault(`${lead} ${window}: minor and patch bumps merge once CI goes green; a major waits for a maintainer as well. ${tail}`), null);
  assert.equal(majorMergeFault(`${lead} ${window}. ${tail}`), null);

  // The text as it stood before #1956, and the paraphrase #1753 accepted of it.
  assert.match(majorMergeFault(`${lead} ${window}: the merge waits on the required checks, whenever they finish. ${tail}`), /#1956/);
  assert.match(majorMergeFault(`${lead} The window only limits when Renovate raises the pull request; merging happens whenever the required checks go green. ${tail}`), /#1956/);
  // Half the exception: a major with no human, or a human with no major.
  assert.match(majorMergeFault(`${lead} ${window}: the merge waits on the required checks, major or not. ${tail}`), /#1956/);
  assert.match(majorMergeFault(`${lead} ${window}: the merge waits on the required checks and a human. ${tail}`), /#1956/);
  // "automerges"/"automerged" makes the same unscoped claim without the bare
  // word "merge" — the trigger must catch it too, scoped or not (#1956 follow-up).
  assert.match(majorMergeFault(`${lead} ${window}: every bump automerges once the required checks pass. ${tail}`), /#1956/);
  assert.equal(majorMergeFault(`${lead} ${window}: every bump automerges once the required checks pass, except a major, which waits on a human. ${tail}`), null);
  // The ceiling: the next sentence's exception does not scope this one.
  assert.match(majorMergeFault(`${lead} ${window}: the merge waits on the required checks. A major waits on a human too. ${tail}`), /#1956/);
});

test("pinOwnerComment refuses to pick silently between two setup-node comments that both cite ADR 0010 (#1838)", () => {
  const lines = [
    "    steps:",
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
    "    steps:",
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
  if (lines === 0) return "carries no comment directly above its opener — no pointer to ADR 0010 or the do-not-hand-edit rule, and a comment with a blank line under it is not the step's";
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

// The prefix every synthetic workflow below hangs its steps from: a job, and
// its `steps:` key (#1920 — a step is only an entry of `steps:`). Shapes that
// vary the job or `steps:` spelling itself still spell it out.
const job = ["  job:", "    steps:"];

// The comment run a bare `- uses:` step directly under `comment` gets.
const at = (...comment) => setupNodeComments([...job, ...comment, "      - uses: actions/setup-node@v5"])[0];

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
  assert.deepEqual(setupNodeComments([...job, ...named]), [{ block: "", lines: 0, job: "job" }]);
  assert.match(pointerFault(setupNodeComments([...job, ...named])[0]), /no comment directly above its opener/);

  // What the wider match must still ACCEPT: a pointer above the opener, with
  // sibling keys, a nested value or a quoted scalar anywhere in between.
  for (const step of [
    named,
    ["      - id: node", "        with:", "          node-version-file: .nvmrc", "        uses: 'actions/setup-node@v5'"],
    ['      - uses: "actions/setup-node@v5"'],
  ]) {
    const found = setupNodeComments([...job, pointer, ...step]);
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
  assert.match(pinOwnerComment(["    steps:", ...owner]), /monthly schedule: see ADR 0010/);
  assert.throws(() => pinOwnerComment(["    steps:", ...decoy, ...owner]), /2 setup-node comment blocks citing "ADR 0010"/);
});

// The wider match's own false-positive class: a `uses:` line is a step only
// when the first shallower line above it opens a sequence entry. Under `with:`
// it is not, and a phantom step there would red the pointer test over a step
// that does not exist. It sits under `steps:`, so it is that first shallower
// line, not #1920's parent check, refusing it. Inside a `run:` script the line
// is refused the same way — `run: |` opens no sequence entry either, so the
// shallower-line check above never needs #1975's block-scalar check to catch
// this shape, though that check would refuse it too.
test("a `uses: actions/setup-node@` line that is not a step's own key is not taken for a step (#1873)", () => {
  const scripted = ["      - name: Print an example", "        run: |", "          uses: actions/setup-node@v5"];
  const nested = ["      - uses: some/action@v1", "        with:", "          uses: actions/setup-node@v5"];
  assert.deepEqual(setupNodeComments([...job, ...scripted]), []);
  assert.deepEqual(setupNodeComments([...job, ...nested]), []);
});

// #1920. That first shallower line can open a sequence entry and still not be
// a step's: a list nested in `with:` or a matrix `include:` has `- ` entries of
// its own, keyed at exactly the column of a `uses:` under them — or written as
// `- uses:` outright — so no column check tells them from a step. What does is
// the key they hang from: a step is an entry of `steps:`. And a key written on
// the dash line itself (`- with:`) makes the step's opener the first shallower
// line above a `uses:` nested in that key's value; there the column does tell,
// because a step's own keys start where the text after its `- ` does. The
// `run: |` shapes here are still refused by those same two mechanisms — the
// nested one because `run: |` opens no sequence entry, the dash-line one by
// the column tell just above — not because #1975's block-scalar check ran;
// that check would refuse either shape too, but neither depends on it.
test("a `uses: actions/setup-node@` line under an entry that is not a step's, or inside a key on a step's dash line, is not a step (#1920)", () => {
  for (const shape of [
    [...job, "      - uses: some/action@v1", "        with:", "          items:", "            - key: a", "              uses: actions/setup-node@v5"],
    [...job, "      - uses: some/action@v1", "        with:", "          items:", "            - uses: actions/setup-node@v5"],
    [...job, "      - name: Print an example", "        run: |", "          - uses: actions/setup-node@v5"],
    ["  job:", "    strategy:", "      matrix:", "        include:", "          - node: 20", "            uses: actions/setup-node@v5"],
    [...job, "      - run: |", "          uses: actions/setup-node@v5"],
    [...job, "      - with:", "          uses: actions/setup-node@v5"],
    [...job, "      - uses: some/action@v1", "        with:", "          - uses: actions/setup-node@v5"],
    ["  job:", "    volumes:", "      -", "        uses: actions/setup-node@v5"],
  ]) {
    assert.deepEqual(setupNodeComments(shape), [], shape.join("\n"));
  }

  // What the two checks must still ACCEPT: entries level with `steps:`, keys
  // set wide of the dash or starting on the line under a bare one, a comment on
  // `steps:`, and an earlier step whose `with:` nests an entry of its own.
  const text = "Exact pin Renovate moves: see ADR 0010. Do not hand-edit this to float.";
  for (const shape of [
    [...job, `    # ${text}`, "    - name: Set up Node", "      uses: actions/setup-node@v5"],
    [...job, `    # ${text}`, "    - uses: actions/setup-node@v5"],
    [...job, `      # ${text}`, "      -   name: Set up Node", "          uses: actions/setup-node@v5"],
    [...job, `      # ${text}`, "      -", "        name: Set up Node", "        uses: actions/setup-node@v5"],
    [
      "  job:",
      "    steps: # one entry per step",
      "      - uses: some/action@v1",
      "        with:",
      "          items:",
      "            - key: a",
      "",
      `      # ${text}`,
      "      - name: Set up Node",
      "        uses: actions/setup-node@v5",
    ],
  ]) {
    assert.deepEqual(setupNodeComments(shape), [{ block: text, lines: 1, job: "job" }], shape.join("\n"));
  }
});

// #1920 follow-up: `steps:` is only a key spelled that way — the parent check
// alone never verifies it opens the JOB's list rather than some nested config
// that happens to reuse the name. An action's `with:` block (or any other
// nesting) can carry its own key called `steps:` several levels down; without
// checking that `steps:` itself hangs from a job, that nested key passes the
// parent check exactly like the real one and manufactures a phantom step.
test("a nested key merely spelled `steps:` cannot own a step; only one hanging from a job can (#1920 follow-up)", () => {
  const collision = [
    ...job,
    "      - uses: some/action@v1",
    "        with:",
    "          config:",
    "            steps:",
    "              - uses: actions/setup-node@v5",
  ];
  assert.deepEqual(setupNodeComments(collision), [], collision.join("\n"));
});

// #1920 follow-up: the column check's bare-`-` exemption matched only a dash
// with NOTHING after it. A dash followed by a trailing comment (a note on the
// opener itself, not one of its keys) has no key text of its own either, but
// the comment's own column is not its keys' column — so without the same
// exemption, a real step opened that way silently dropped out of the
// returned set instead of being found.
test("a bare `-` opener followed only by a trailing comment does not perturb the column check; the step is still discovered (#1920 follow-up)", () => {
  const found = setupNodeComments([...job, "      -  # Set up Node", "        name: Set up Node", "        uses: actions/setup-node@v5"]);
  assert.deepEqual(found, [{ block: "", lines: 0, job: "job" }]);
});

// #1975. A block scalar's content — a `run: |` script, a github-script body, a
// heredoc writing a fixture workflow — is one string, however much of it is
// spelled like keys, `- ` entries or comments. Read as structure it made a
// phantom step, or lent the step under it a comment that was a line of the
// script above. At a step's depth #1920's job check already refuses the
// phantom, since no line of a step's scalar sits where a job key does; a
// top-level scalar's content can, and the comment run has no job check at all.
test("a block scalar's content is text: never a step, never a step's comment (#1975)", () => {
  const setup = "      - uses: actions/setup-node@v5";
  const text = "Exact pin Renovate moves: see ADR 0010. Do not hand-edit this to float.";

  // A job-shaped fixture as a top-level scalar, the last with an indentation
  // indicator setting its content shallower than its first line, which
  // auto-detection would miss.
  for (const shape of [
    ["description: |", ...job, setup],
    ["description: >-", ...job, setup],
    ["description: |2", "    deeper", ...job, setup],
  ]) {
    assert.deepEqual(setupNodeComments(shape), [], shape.join("\n"));
  }

  // Each header spelling, its script ending in a shell comment right above the
  // next step's opener: that line is the script's, not the step's comment. A
  // bare `- |` is the entry's own value, so its content need only sit deeper
  // than the dash, not than a key.
  const script = ["          npm run build", "          # shell note, script content"];
  for (const scalar of [
    ["      - name: Build", "        run: |", ...script],
    ["      - name: Build", "        run: >-", ...script],
    ["      - name: Build", "        run: |+ # keep the final newline", ...script],
    ["      - name: Build", "        run: &build |", ...script],
    ["      - name: Build", "        run: !!str |", ...script],
    ["      - name: Build", '        "run": |2', ...script],
    ["      - run: |", ...script],
    ["      - |", "        npm run build", "        # shell note, script content"],
  ]) {
    const shape = [...job, ...scalar, setup];
    assert.deepEqual(setupNodeComments(shape), [{ block: "", lines: 0, job: "job" }], shape.join("\n"));
  }

  // What the check must still ACCEPT: a comment the scalar has ended before —
  // back at the dash, or deeper than `run:` but shallower than the script's
  // own lines, where YAML ends the scalar too — a value that merely ends in a
  // `|`, and a step after a top-level scalar.
  for (const shape of [
    [...job, "      - name: Build", "        run: |", "          npm run build", `      # ${text}`, setup],
    [...job, "      - name: Build", "        run: |", "          npm run build", `         # ${text}`, setup],
    [...job, "      - name: Build", "        run: npm test ||", `          # ${text}`, setup],
    ["description: |", "  text", "jobs:", ...job, `      # ${text}`, setup],
  ]) {
    assert.deepEqual(setupNodeComments(shape), [{ block: text, lines: 1, job: "job" }], shape.join("\n"));
  }

  // An empty scalar ends where it starts: a key level with its own is the
  // step's next key, whether the scalar's key sits on the dash line or not.
  for (const shape of [
    [...job, "      - run: |", "        uses: actions/setup-node@v5"],
    [...job, "      - name: Build", "        run: |", "        uses: actions/setup-node@v5"],
  ]) {
    assert.deepEqual(setupNodeComments(shape), [{ block: "", lines: 0, job: "job" }], shape.join("\n"));
  }

  // Boundary precision on the depth arithmetic itself: an explicit
  // indentation indicator's depth is the KEY's column plus the indicator —
  // not the indicator alone — and a comment sitting one column shy of that
  // depth has already left the scalar, so it is the next step's real
  // comment, not swallowed script text. The chomping-then-indicator spelling
  // (`|-2`) carries its digit in the same place as `|2-`; a first content
  // line indented deeper than the indicator still leaves the depth at the
  // indicator's own value, not an auto-detected one, which a second,
  // shallower-but-still-in-scalar line below it proves. And a bare dash's
  // column is the dash's own position, not one past it: content one column
  // beyond it is swallowed, and nothing shallower is reachable without
  // leaving the entry.
  assert.deepEqual(
    setupNodeComments([
      ...job,
      "      - name: Build",
      "        run: |2",
      "          npm run build",
      "         # a real comment for the next step",
      setup,
    ]),
    [{ block: "a real comment for the next step", lines: 1, job: "job" }],
  );
  assert.deepEqual(
    setupNodeComments([
      ...job,
      "      - name: Build",
      "        run: |-2",
      "            npm run build",
      "          # would-be leaked comment",
      setup,
    ]),
    [{ block: "", lines: 0, job: "job" }],
  );
  assert.deepEqual(
    setupNodeComments([...job, "      - |", "       # inside the scalar, must not surface as a comment", setup]),
    [{ block: "", lines: 0, job: "job" }],
  );
});

// #1975. Each key the walk reads by name was matched in its bare spelling
// only, so a genuine step under a quoted `"steps":` — valid YAML — silently
// dropped out of the returned set; a quoted `uses:` or job key did the same,
// and so did a job key carrying a trailing comment.
test("a key spelled quoted, with a space before its colon, or with a trailing comment still names it (#1975)", () => {
  const setup = "      - uses: actions/setup-node@v5";
  for (const shape of [
    ["jobs:", "  job:", '    "steps":', "      - name: x", "        uses: actions/setup-node@v5"],
    ["jobs:", "  job:", "    'steps':", setup],
    ["jobs:", "  job:", "    steps :", setup],
    ["jobs:", ...job, '      - "uses": actions/setup-node@v5'],
    ["jobs:", ...job, "      - name: x", "        'uses' : actions/setup-node@v5"],
    ["jobs:", '  "job":', "    steps:", setup],
    ["jobs:", "  job :", "    steps:", setup],
    ["jobs:", "  job: # the job's own note", "    steps:", setup],
  ]) {
    assert.deepEqual(setupNodeComments(shape), [{ block: "", lines: 0, job: "job" }], shape.join("\n"));
  }

  // A key that only contains the name is still not it.
  for (const shape of [
    ["jobs:", "  job:", "    pre-steps:", setup],
    ["jobs:", "  job:", '    "steps2":', setup],
  ]) {
    assert.deepEqual(setupNodeComments(shape), [], shape.join("\n"));
  }
});

// #2000. Four more gaps in the same two functions as #1975's, confirmed
// against PyYAML and confirmed identical on PR #1995's base and head —
// pre-existing, not a regression of that fix. Grouped by the ticket's own
// finding numbers for traceability.
test("an anchor or tag on a job key or a uses: key does not drop the step (#2000 finding 1)", () => {
  assert.deepEqual(setupNodeComments(["jobs:", "  job: &j", "    steps:", "      - uses: actions/setup-node@v5"]), [
    { block: "", lines: 0, job: "job" },
  ]);
  assert.deepEqual(setupNodeComments(["jobs:", ...job, "      - uses: &u actions/setup-node@v5"]), [
    { block: "", lines: 0, job: "job" },
  ]);
});

test("uses: with no whitespace before its value is a plain scalar, never a step's own key (#2000 finding 2)", () => {
  assert.deepEqual(setupNodeComments(["jobs:", ...job, "      - uses:actions/setup-node@v5"]), []);
});

test("a plain key containing a literal # is still a block-scalar header, not read as structure (#2000 finding 3)", () => {
  assert.deepEqual(setupNodeComments(["C#: |", ...job, "      - uses: actions/setup-node@v5"]), []);
});

test("a document-start scalar (--- |) is still a block-scalar header, not read as structure (#2000 finding 4)", () => {
  assert.deepEqual(setupNodeComments(["--- |", ...job, "      - uses: actions/setup-node@v5"]), []);
});

// Found in review of #2005, alongside the ticket's own five: the bare `!`
// non-specific tag (YAML's tag shorthand with no characters of its own) was
// refused by the `\S+` this PR's finding-1 fix used for the anchor/tag
// token, where blockScalarText's own header regex above already accepted it
// via `\S*`. Confirmed against PyYAML (`compose`): both shapes hold a real
// step.
test("a bare ! non-specific tag on a job key or a uses: key does not drop the step", () => {
  assert.deepEqual(setupNodeComments(["jobs:", "  job: !", "    steps:", "      - uses: actions/setup-node@v5"]), [
    { block: "", lines: 0, job: "job" },
  ]);
  assert.deepEqual(setupNodeComments(["jobs:", ...job, "      - uses: ! actions/setup-node@v5"]), [
    { block: "", lines: 0, job: "job" },
  ]);
});

// Found in review of #2005: a document-start scalar's own indentation
// indicator of exactly 1 set `depth` to 0 (column −1 plus indicator 1), a
// floor no real line's column can ever go under, so the scalar never closed
// and swallowed every later document whole — including a real step in one.
// ci.yml has no document marker today, so this was unreachable there, but
// PyYAML confirms the second document's step is real.
test("a document marker still ends a document-start scalar that carries an explicit indentation indicator", () => {
  assert.deepEqual(
    setupNodeComments(["--- |1", " text", "---", "jobs:", ...job, "      - uses: actions/setup-node@v5"]),
    [{ block: "", lines: 0, job: "job" }],
  );
});

// #2000 finding 5, deliberately NOT fixed here: blockScalarText's own doc
// comment above says why — the comment-run walk has no job check to mirror
// the one #1920 gives the phantom-step half, so a multi-line quoted or
// plain scalar can still lend a step the wrong comment. ci.yml has no such
// scalar today, so the gap is latent, and detecting one needs the same
// column/indentation tracking this file already does for block scalars,
// extended to a wholly different, unindented production — its own design
// work the other four findings didn't need.

// #1919. A blank line ends a step's comment run wherever it falls — the rule
// the failglob and Validate JSON walks in this file follow too, so no walk here
// disagrees with another about where a comment stops. Above a pointer,
// that is the ceiling pointerFault documents: the blank line keeps an
// unrelated comment out of the pointer's run. Under a comment, it detaches the
// comment from the step: ci.yml sets a blank line between each step and the
// one before it, and every comment directly on the step it explains, so a
// comment with a blank line under it is, by the file's own layout, not the
// step's. Skipping that one gap instead would hand the step whatever floats
// above it — a commented-out step, a trailing note on the step before. Pinned
// in both halves and both opener forms, so the boundary is a decision, not
// whatever the walk happens to do; the fault names the cause, because "no
// comment at all" was false with a comment sitting right over the blank line.
test("a blank line ends a setup-node step's comment run: it keeps an unrelated comment out, and detaches a comment from the step (#1919)", () => {
  const pointer = "      # Exact pin Renovate moves: see ADR 0010. Do not hand-edit this to float.";
  const unrelated = "      # An unrelated note that happens to sit above the step.";
  for (const step of [
    ["      - uses: actions/setup-node@v5"],
    ["      - name: Set up Node", "        uses: actions/setup-node@v5"],
  ]) {
    const hugging = setupNodeComments([...job, unrelated, "", pointer, ...step]);
    assert.deepEqual(hugging, [{ block: pointer.replace(/^\s*#\s?/, ""), lines: 1, job: "job" }], step.join("\n"));
    assert.equal(pointerFault(hugging[0]), null, step.join("\n"));

    const detached = setupNodeComments([...job, pointer, "", ...step]);
    assert.deepEqual(detached, [{ block: "", lines: 0, job: "job" }], step.join("\n"));
    assert.match(pointerFault(detached[0]), /no comment directly above its opener/, step.join("\n"));
  }
});

test("a paraphrased pointer is accepted; a missing one, a half one and a copied paragraph are not", () => {
  assert.equal(pointerFault(at("      # Exact pin Renovate moves: see ADR 0010. Do not hand-edit this to float.")), null);
  assert.equal(pointerFault(at("      # .nvmrc is exact and bot-moved (ADR 0010); never hand-edit it to float.")), null);
  assert.equal(pointerFault(at("      # Hand-editing this to float is not allowed: ADR 0010 explains why.")), null);

  assert.match(pointerFault(at()), /no comment directly above its opener/);
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
  assert.equal(pointerFault(at("      # .nvmrc is exact and bot-moved (ADR 0010); it cannot be hand-edited to float.")), null);
  assert.equal(pointerFault(at("      # Exact pin Renovate moves: see ADR 0010. Don’t hand-edit this to float.")), null);
  assert.equal(pointerFault(at("      # Never, e.g. for a patch, hand-edit this pin: see ADR 0010.")), null);
});

test("pointerFault still refuses a rule spelled with the opening curly quote — only U+2019 is accepted (#1852)", () => {
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
// "manifests", none of them ending a sentence. A word ENDING in a period, or in
// a period followed only by a closing quote or parenthesis ("them.)", `them."`),
// is the sentence end — the old check looked only at a word's LAST character,
// so a closer sitting after the period read as an ordinary word and let the
// window run past the real sentence end into unrelated text (#1945). One word
// merely containing a period, with no closer-after-terminator at its end, is
// still a file name, not a boundary — "seven tracked `*.json` files" is the
// count. The digit branch also refuses to start right after a hyphen, so a
// date fragment like "2026-09-08" can't hand its last segment to the window as
// a bare count ("08 files", #1945). Plural nouns only, because the jq
// rationale in the same block says the step "exits 1 on a file holding
// `null`": a singular noun would read that exit status as a count. That is the
// ceiling as well — "exactly one tracked JSON file" passes, and so does a bare
// list of paths with no count in front of it. The block is the contiguous
// comment run above the step, anchored on the step's name like the failglob
// pin, so a count moved into another step's comment is outside it.
const JSON_COUNT =
  /\b(?:(?<!-)\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|(?:twen|thir|for|fif|six|seven|eigh|nine)ty(?:[- ]?(?:one|two|three|four|five|six|seven|eight|nine))?|dozen|both)\s+(?:(?!\S*[.!?][)\]"'\u2019\u201d]*\s)\S+\s+){0,2}?(?:files|manifests)\b/i;

// JSON_COUNT alone is context-blind: it flags a "<count> files" shape ANYWHERE
// in the block, whether or not that particular phrase sizes the tracked set at
// all — "The 2026-09-08 split removed two files that duplicated coverage"
// matched exactly like a real count, which would false-positive-fail CI on a
// legitimate future comment edit (#1945). Nor is a context word anywhere in the
// same sentence enough: this whole block is ABOUT JSON, so "two files that
// duplicated JSON coverage", "two files from plugin.json's directory",
// "Renovate tracked two files there" and "both valid JSON files would
// otherwise fail" all carry one without sizing anything (#1991). So the
// context word has to be attached to the count phrase itself, in one of three
// places — the ones every genuine sizing sentence below uses:
//   - as the count's own modifier, the word right after the count:
//     "two tracked JSON files", "seven tracked `*.json` files", "the 7 JSON
//     files". Only the FIRST word: "both valid JSON files" is a property of
//     two files, not the name of the set;
//   - as the clause the noun opens: "files are tracked", "files that
//     `git ls-files` lists";
//   - as the clause the count is set off from by a comma, colon, semicolon or
//     dash, at most two words back: "Parses what `git ls-files` lists, both
//     plugin manifests among them." — the context sits a clause away from the
//     count, and only the punctuation says the count sizes what came before.
// "json" counts only as a word of its own or the `*.json` glob, never as a
// file name's extension ("plugin.json"). The ceiling: a count sentence with
// no context word of its own, right after one that has it ("Every tracked
// `*.json` file. Seven files at last count."), passes — sentences are the
// unit. The existing "The 2026-09-08 split removed two of them." fixture
// must pass too, for a simpler reason: "two of them" is not a JSON_COUNT
// match at all.
const JSON_SET_WORD = String.raw`(?:\btracked\b|(?<![\w.\/-])json\b|\*\.json\b|git ls-files\b)`;
const JSON_COUNT_ALL = new RegExp(JSON_COUNT.source, "gi");
const JSON_COUNT_MODIFIER = new RegExp(String.raw`^\S+\s+(?:(?:one|two|three|four|five|six|seven|eight|nine)\s+)?[\x60'"(]*${JSON_SET_WORD}`, "i");
const JSON_COUNT_CLAUSE_AFTER = new RegExp(String.raw`^\s*(?:(?:that|which)\s+)?(?:(?:are|were)\s+)?[\x60]?${JSON_SET_WORD}`, "i");
const JSON_COUNT_CLAUSE_BEFORE = new RegExp(String.raw`${JSON_SET_WORD}[^\s,:;\u2013\u2014-]*(?:\s+[^\s,:;\u2013\u2014-]+){0,2}\s*[,:;\u2013\u2014-]\s*$`, "i");

function sizesTrackedSet(sentence, count) {
  return (
    JSON_COUNT_MODIFIER.test(count[0]) ||
    JSON_COUNT_CLAUSE_AFTER.test(sentence.slice(count.index + count[0].length)) ||
    JSON_COUNT_CLAUSE_BEFORE.test(sentence.slice(0, count.index))
  );
}

export function jsonCountFault(block) {
  // The coverage check, scoped to the block's FIRST sentence only. A
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
  const sents = sentences(block);
  const lead = sents[0] ?? "";
  if (!/\btracked\b|git ls-files/.test(lead)) {
    return "the Validate JSON comment no longer says which files the step parses — the slice this pin reads has lost its coverage paragraph";
  }
  // The count check, scoped one sentence at a time instead of the whole block
  // (#1945) — see sizesTrackedSet above for why. `sentences()` itself only
  // splits at a terminator immediately followed by whitespace, so a
  // parenthetical or quoted aside ending "...files.)" or `...files."` does
  // NOT end a sentences()-slice there — it runs on into the NEXT real
  // sentence, which can carry an unrelated "tracked"/"json" word of its own.
  // JSON_COUNT's own window already treats that identical terminator-then-
  // closer as a boundary (the #1945 fix above), so the loop below re-splits
  // each `sentences()` slice on the SAME boundary before testing context —
  // otherwise a count sentence borrows a following real sentence's context
  // word through the gap `sentences()` leaves open, and the #1942 bug
  // returns for any aside written in parentheses or quotes (PR #1984 review,
  // #1945).
  const countSentenceBoundary = /(?<=[.!?][)\]"'\u2019\u201d]*)(?<!\b(?:e\.g|i\.e|cf|viz|vs)\.[)\]"'\u2019\u201d]*)\s+/i;
  for (const sentence of sents.flatMap((s) => s.split(countSentenceBoundary))) {
    // Every match, not just the first: a sentence can open on an aside
    // ("removed two files that duplicated coverage") and size the set later.
    for (const count of sentence.matchAll(JSON_COUNT_ALL)) {
      if (sizesTrackedSet(sentence, count)) {
        return `the Validate JSON comment sizes the tracked JSON set again ("${count[0]}") — a count there goes stale the next time a JSON file is added (#1903)`;
      }
    }
  }
  return null;
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
    "Twenty one tracked JSON files exist today.",
    "Parses what `git ls-files` lists - both plugin manifests among them.",
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

// Review of PR #1942 (deferred to #1945): JSON_COUNT flagged a "<count>
// files" shape ANYWHERE in the block regardless of what that sentence was
// about, so an unrelated aside sharing the shape — sizing a past cleanup,
// not the tracked set — matched exactly like a real count. Reworded slightly
// (spelling out "files" instead of "of them"), either sentence below would
// have false-positive-failed CI on a legitimate future comment edit. Fixed
// by requiring a "tracked"/"json"/"git ls-files" context word alongside the
// count — since #1991, attached to the count phrase (see sizesTrackedSet).
test("jsonCountFault ignores a count-shaped aside whose own sentence never sizes the tracked JSON set (#1945)", () => {
  const jq = "`jq empty`, not `jq -e .`: it exits 1 on a file holding `null` or `false` — both valid JSON.";
  const lead = "Parses every file `git ls-files '*.json'` lists.";
  assert.equal(jsonCountFault(`${lead} The 2026-09-08 split removed two files that duplicated coverage. ${jq}`), null);
  assert.equal(jsonCountFault(`${lead} Two files were added to unrelated tooling that week. ${jq}`), null);
});

// Review of PR #1942 (deferred to #1945): the window's sentence-end rule
// looked only at a word's LAST character, so a period followed by a closing
// paren or quote wasn't a boundary — "them.)" and `them."` both read as
// ordinary words and let the window run past the real sentence end into
// unrelated "Files" text. The digit branch was also unanchored against a
// trailing date fragment, so "2026-09-08 files" matched as "08 files". All
// three fixed directly on JSON_COUNT. The first three asserts below carry no
// "tracked"/"JSON" context word of their own, so sizesTrackedSet already
// refuses them regardless of JSON_COUNT's boundary behavior — they prove the
// two fixes stack, not that either fires alone (PR #1984 review). The last
// three put "tracked" right after the count — where sizesTrackedSet reads it
// as the count's own modifier (#1991) — so the context test cannot be what
// returns null: only a sentence end at `ones.)` / `ones."` (sentences() or
// JSON_COUNT's own window) and the digit branch's hyphen anchor can.
test("jsonCountFault treats a period-then-closer as a sentence end, and refuses a date fragment's last segment as a bare count (#1945)", () => {
  const jq = "`jq empty`, not `jq -e .`: it exits 1 on a file holding `null` or `false` — both valid JSON.";
  const lead = "Parses every file `git ls-files '*.json'` lists.";
  assert.equal(jsonCountFault(`${lead} Removed two of them.) Files added since need no edit. ${jq}`), null);
  assert.equal(jsonCountFault(`${lead} Removed two of them." Files added since need no edit. ${jq}`), null);
  assert.equal(jsonCountFault(`${lead} 2026-09-08 files were touched that week. ${jq}`), null);
  assert.equal(jsonCountFault(`${lead} Removed two tracked ones.) Files added since need no edit here. ${jq}`), null);
  assert.equal(jsonCountFault(`${lead} Removed two tracked ones." Files added since need no edit here. ${jq}`), null);
  assert.equal(jsonCountFault(`${lead} 2026-09-08 tracked files were touched that week. ${jq}`), null);
});

// #1991 (deferred from PR #1984 review): a context word anywhere in the count's
// sentence was not evidence the count sizes the tracked set, because the whole
// Validate JSON block is about JSON — every sentence in the accept loop below
// carries "JSON", "plugin.json" or "tracked" without sizing anything, and each
// one flagged. Two of them set the count off by punctuation, the one place the
// context word may sit a clause away: after a file name's ".json", and more
// than two words after "tracked". The last is the block's own jq sentence
// after a natural one-word rewording. The refuse half pins that the context
// test now walks EVERY count in a sentence: its aside comes first, and the
// real count second.
test("jsonCountFault ignores a context word the count phrase does not own, and still finds a sizing count behind an aside (#1991)", () => {
  const jq = "`jq empty`, not `jq -e .`: it exits 1 on a file holding `null` or `false` — both valid JSON.";
  const lead = "Parses every file `git ls-files '*.json'` lists.";
  for (const aside of [
    "The 2026-09-08 split removed two files that duplicated JSON coverage.",
    "The 2026-09-08 split removed two files from plugin/.claude-plugin/plugin.json's directory.",
    "Beside plugin/.claude-plugin/plugin.json, two files were removed that week.",
    "The tracked set shrank last week: two files that duplicated coverage were deleted.",
    "Renovate tracked two files there last week.",
    "`jq empty`, not `jq -e .`: it exits 1 on a file holding `null` or `false` — both valid JSON files would otherwise fail.",
  ]) {
    assert.equal(jsonCountFault(`${lead} ${aside} ${jq}`), null, aside);
  }
  assert.match(
    jsonCountFault(`${lead} The split removed two files that duplicated coverage, leaving nine tracked JSON files. ${jq}`),
    /sizes the tracked JSON set again \("nine tracked JSON files"\)/,
  );
});
