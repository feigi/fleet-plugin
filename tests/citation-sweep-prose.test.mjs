import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "./support/strip-comments.mjs";

// #516. A scan over every tracked `.mjs`/`.sh`/`.js`/`.yml` file for
// `path.ext:NNN` found 22 line-numbered citations (plus two bare `(:NNN)`
// continuations) and converted every one to name a construct instead — a
// function, a section, a quoted fragment. A line number rots the moment the
// cited file is next touched, silently, because nothing reds when it does;
// that is how #516 itself came to exist. This file is what keeps the OLD
// stale forms from creeping back in one file at a time, the way they crept in
// the first time, and confirms every construct name the sweep introduced is
// still findable somewhere in its file (never pinned to a line — that would
// defeat the point).
//
// Two example strings that LOOK like citations are not: `file.mjs:164` in
// ledger.mjs's prose about search-qualifier smuggling, and `candidates.mjs:164`
// (twice) in ledger.test.mjs, which is that test's own input/assertion
// subject. Neither is touched here — the patterns below are the exact stale
// forms the sweep actually converted, not a general `\.mjs:\d+` ban.
//
// Not #516-only any more. The table is this repo's citation-regression record
// rather than that ticket's frozen inventory: #1136 generalized one entry's ban
// after the number rotted a third time, #1349 retired one whose target no
// longer exists, and #870 adds a pair of citations PR #866 fixed BY HAND
// rather than through a sweep. A citation fixed anywhere in this tree belongs
// here; the alternative is each file growing a private pin that reads its own
// source, which is the per-file creep this file exists to stop.
//
// #1555 widens the subject past line numbers. The select-dimensions.test.mjs
// entry bans a reverted ARGUMENT spelling, not a citation: `lift(SOURCE)`
// where the live code passes `lift(stripComments(SOURCE))`. It belongs here
// because the rot is the same rot — a one-line spelling that still reads
// plausibly, whose revert nothing reds on — and the alternative is the
// private per-file pin the paragraph above rejects. The table's subject is
// the stale FORM; a line number is one kind of stale form.
//
// Both halves here are CITING-side: the stale form must not return, and the
// construct the citation names must still be named. Neither reads the cited
// file, so nothing in this table notices the TARGET losing the construct — the
// direction #870 closes for probe 3's citation, in
// inflight-citation-prose.test.mjs, and leaves open for every entry below
// except where the next two paragraphs say otherwise.
//
// One target-side check runs here, for one citation shape only (#1757): a
// `live` needle that names an ADR by number (`ADR 0010`) is a pointer, and the
// number must still resolve to exactly one `docs/adr/<number>-*.md`. Read off
// the needle itself, never a second list, so the pointer and what it is checked
// against have one spelling between them — the reason inflight-citation-prose's
// WTROOT gives: renumber or move the ADR and this reds; repoint the needle
// alone and the needle reds against the citing file's unchanged prose. The
// pointer names the ADR by number, so a retitle that keeps the number keeps
// the pointer true and stays green.
//
// One construct needle is checked against its target too: ledger.mjs's
// "runDispatch's `keyNum` check", a pointer that names a function and a
// variable inside it. Rename either in the code and the comment points at
// nothing while its needle stays satisfied by the comment's own words, so
// runDispatchKeyNumFault reads comment-stripped ledger.mjs for both. Every
// other construct needle is still never checked against its target.
const REPO = join(import.meta.dirname, "..", "plugin");
const read = (...segments) => readFileSync(join(REPO, ...segments), "utf8");

// Comments wrap; a construct name can land on either side of the wrap. Strip
// the `//` or `#` gutter and collapse whitespace so a presence check does not
// depend on where the line happened to break.
const normalize = (text) => text.replace(/^[ \t]*(?:\/\/|#) ?/gm, "").replace(/\s+/g, " ");

const ADRS = readdirSync(join(REPO, "..", "docs", "adr"), { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);
const ADR_POINTER = /\bADR (\d{4})\b/g;

// Null when exactly one `<number>-*.md` answers to the pointer, else the
// reason. Takes a listing rather than reading docs/adr/ itself, so the tests
// below can hand it the renamed, emptied, and doubled trees this repo does
// not hold.
function adrFault(number, names) {
  const hits = names.filter((name) => name.startsWith(`${number}-`) && name.endsWith(".md"));
  if (hits.length === 1) return null;
  return hits.length === 0
    ? `no docs/adr/${number}-*.md exists — the ADR was renumbered or moved out of docs/adr/`
    : `${hits.length} files answer to ADR ${number} (${hits.join(", ")}) — the pointer no longer names one ruling`;
}

const ADR_0010 = ["..", "docs", "adr", "0010-the-node-pin-stays-exact-and-a-bot-moves-it.md"];
const PIN_DRIFT_SH = ["..", ".github", "scripts", "pin-drift.sh"];

// #1957. Where a sentence ends, for ADR 0010's drift-sentence row below: at
// `.`, `!` or `?`, after any closing markup — `**`, `_`, a backtick, `)`, `]`,
// a quote — then whitespace; or where a markdown block ends: a blank line,
// or the newline before a `-`/`*`/`+` list item. The row's first cut, a bare
// `\.\s`, missed point 3's bold heading ending `bumps.**`, so the heading's
// "minor and patch" read as the next sentence's own scope, and an unscoped
// drift claim under a scoped heading passed. A lone newline is no end: prose
// wraps mid-sentence. So a
// heading with no terminator and no blank line after it still lends the next
// line its scope — telling that line end from a wrap takes parsing the
// heading, which a sentence boundary cannot do.
//
// #1959. A period closing an abbreviation that never ends a sentence — "e.g.",
// "i.e.", "cf.", "viz.", "vs.", ci-comment-rot-prose's list (#1852) — is no
// end either: splitting there dropped a scope word on one side of it out of
// the claim's sentence on the other, and a scoped drift sentence read as
// unscoped. Any other period before whitespace still ends one — "etc.", an
// ellipsis, "a.m." — since each ends a sentence as often as not, and reading
// past a real end is the silent direction: the next sentence's scope would
// reach back. Before the abbreviation, only a letter or digit disqualifies it,
// as for UPDATE_TYPE below: an italic `_e.g._` is one, "devs." is not "vs.",
// and neither is "DEvs." — the guard spells both cases out, so it reads a
// capital the same whatever flag the pattern splicing it carries (#2043).
// The abbreviations match lowercase only, as sentences()'s do (#1899, #2021),
// even inside both rows' `i` flag — the `(?-i:…)` group (Node 23+; .nvmrc pins
// 26): folded, a sentence ending in a proper noun "Vs." read as the
// abbreviation, the silent direction above. The cost: a capitalized one
// anywhere, a parenthetical "(Cf. …)" included, ends the sentence there. Keep
// the group to literals: V8 (14.6) still folds a character class in any but
// its first alternative. Every consumer below compiles it with `i`: a
// consumer that once split on it with no flag read a capital glued to an
// abbreviation and a tag name in capitals as no other consumer did (#2043).
//
// #1981. The rest of the block ends and closing markup #1957 named only in
// part. A blank line may be CRLF, or blank but for a gutter — a blockquote's
// `>`, a shell comment's `#` as in pin-drift.sh (a bare `#` is an empty
// heading in markdown, so a block end there too) — or hold only a setext
// underline or thematic break, `---`, `===`, `***`, `___`. A block may open
// behind that gutter too: a list item, ordered as well — `1)` as well as
// `1.`, which the terminator branch only caught by the accident of its `. ` —
// a code fence or a table row. Any item number counts, since every item past
// a list's first carries one, so a wrapped line opening "2) " ends the
// sentence it continues: the loud direction, as above. An ellipsis `…` ends a
// sentence with or without whitespace after it: unlike a period it sits inside
// no version, file name or range, where three periods do — `main...HEAD` — so
// `...` still needs the whitespace. Closing markup also takes strikethrough's
// `~~`, `}`, `>`, `»`, `›` and an HTML closing tag such as `</b>`. Still no end:
// an ATX heading with no blank line before it, since every line behind the
// `# ` gutter would open one and the merge row reads sentences across it.
//
// #2002. More of what CommonMark (0.31.2) lets interrupt a paragraph, and
// closing markup #1981 still missed. An HTML block opens straight under
// prose with no blank line between — `<div>`, `<table>`, `<details>`, `<!--`,
// `<?`, `<!DOCTYPE`, `<pre>`, any of CommonMark's block tag names, opening or
// closing — and ends the sentence there; any other tag, `<span>` or
// `<divider>`, opens no block, so the line still wraps. A blockquote's `>`
// ends it too, opening straight under an unquoted line. Two quoted lines wrap
// behind the gutter, and so does a quote nested inside one, `> a` then
// `> > b` — the silent direction, like the ATX gap above, left since telling it
// from a wrap means counting both lines' `>`; a lazy line between two quoted
// ones splits the quote in two, the loud direction. Neither this branch nor
// the HTML block's own caps how far a `<div>`/`>` line can indent, unlike the
// setext/thematic branch below — a line indented four or more spaces still
// ends the sentence here, the same loud direction the pre-existing list
// lookahead already allowed. A setext underline or thematic break is now only
// what CommonMark renders as one: a run of `=` or of `-`, or three or more of
// one of `-`, `*`, `_`, spaced or not, indented at most three spaces past the
// gutter. `_`, `**`, `-=-`, `*-_` or `    ---` is a paragraph line, and reading
// one as an end was the loud direction. That three-space cap counts from the
// margin, not a list item's own content column — inside a list item a deeper
// underline can still be a real end CommonMark would honor; the silent
// direction, left beside the ATX and nested-quote gaps above, since a
// line-based regex can't carry a list item's column forward. A `#` is gutter
// unless it's followed directly by a digit, as in a shell comment, an ATX
// heading or a comment-only rule line (`#---`, `#===`): a wrapped line
// opening `#1906) ` is a citation, not a gutter and a list item. Closing
// markup also takes a link's destination or reference label,
// `](renovate.json)` or `][ref]`, a footnote reference `[^1]`, and a closing
// tag with a hyphen in its name or whitespace before its `>`, `</my-el>`,
// `</b >`. Tag names match in either case only where the splicing pattern
// carries `i`, as every consumer of SENTENCE_END here does (#2043).
//
// #2027. A bare footnote marker straight behind the terminator — `.[1]`,
// `?[note]`, `.[1][2]`, closing markup allowed after it — ends the sentence
// after it, as sentences() in prose-pin.mjs has since #1987. Without it
// `only.[1] Bounding drift…` read as one sentence here while sentences() read
// two, the silent direction for both rows. It is sentences()'s rule, not a
// bare `\[[^\]]*\]`: the marker holds at least one character and no
// whitespace, and the terminator must close a word, a digit, a code span, a
// paren or a curly quote — so jq's `'.[] | …'`, JavaScript's `m?.[1] || …`, a
// glob's `*.[0-9]*' ` and jq's `.jobs.[0, 1] | …` end nothing, and a single
// unspaced `.jobs.[0] | …` still does, the same known gap sentences() carries.
// One divergence, forced: every consumer here compiles without `u`, where
// `\p{L}` is a literal "p" (see UPDATE_TYPE's #1988 note), so "a letter" is
// an ASCII one or ANY non-ASCII character — every non-ASCII letter sentences()
// takes, `”` and `’` included, and also non-ASCII punctuation such as `»`,
// which sentences() does not take. That extra split is the loud direction for
// the rows, and none of the code shapes above starts with one. The caret form
// `[^1]` stays in CLOSING_MARKUP, unguarded, as #2002 left it.
//
// #2063. The `][ref]` closer skips a label `[^1]` reads whole — `][^1]` is
// `]` then `[^1]` and nothing else — so no run of closers has two readings.
// Read both ways, a chain of n `][^1]` had 2^n, and a match failing after
// it walked all of them first. `][^]` and `][^a b]`, which `[^1]` cannot
// read, stay `][ref]` closers.
const FOOTNOTE_MARKERS = String.raw`(?:(?<=[A-Za-z\d\x60)\u0080-\uFFFF][.!?])(?:\[[^\]\s]+\])+)?`;
const CLOSING_MARKUP = String.raw`(?:[*_\x60)\]}>~"'”’»›]|\]\([^()]*\)|\]\[(?!\^[^\]\s]+\])[^\]]*\]|\[\^[^\]\s]+\]|<\/[a-z][a-z\d-]*\s*>)`;
const HASH_GUTTER = String.raw`[ \t]*#(?!\d)`;
const GUTTER = String.raw`(?:[ \t]*>|${HASH_GUTTER})`;
const HTML_BLOCK_OPEN = String.raw`<(?:!--|\?|![A-Za-z]|!\[CDATA\[|(?:script|pre|style|textarea)(?=[\s>]|$)|\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?=[\s>]|\/>|$))`;
const SENTENCE_END = String.raw`(?:(?:[!?]|(?<!(?<![A-Za-z\d])(?-i:e\.g|i\.e|cf|viz|vs))\.)${FOOTNOTE_MARKERS}${CLOSING_MARKUP}*\s|…${CLOSING_MARKUP}*\s?|\n(?=${GUTTER}*[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]|\x60{3}|~{3}|\||${HTML_BLOCK_OPEN}))|\n(?=(?:${HASH_GUTTER})*[ \t]*>)(?<=(?:^|\n)(?!(?:${HASH_GUTTER})*[ \t]*>)[^\n]*\n)|\n${GUTTER}*[ \t]*\r?\n|\n(?:${GUTTER}+ ?)? {0,3}(?:=+|-+|(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*\r?\n)`;
// #1958. What names an update type, for both of ADR 0010's #1906 rows below:
// minor, patch or major as a whole word. The rows' first cut matched the bare
// substring, so "dispatched" and "majority" scoped a claim that names no
// update type, and an unscoped bold span or drift sentence passed. `\b` is not
// the boundary either: it counts `_` as a word character, so an italic
// `_patch_` would stop scoping its claim. Only an ASCII letter or digit beside
// the word disqualifies it. A plural still names the type — "automerged for
// minors and patches" is scoped — so minors, majors and patches count;
// "patched" and "patching" do not.
//
// #1988. Three holes are left open, each a word that names no update type
// still scoping its claim. The plain-English sense: "patches" read as a verb,
// as #1958 left it, and "we patch monthly", "at minor cost", "a major
// benefit". A whole word cannot tell that sense from the update type, and
// asking for the type's own context — "bump" beside it — refuses "Majors
// aside" and "for minors and patches", prose that names exactly the scope the
// rows ask for. A word no reader sees: a link target, as in
// `[notes](https://x.io/patch-notes)`, a reference label, an HTML comment.
// Refusing those takes one more lookbehind on `UPDATE_TYPE` itself, for
// markup ADR 0010 has none of. And a non-ASCII letter
// beside the word: "patché" scopes. `[\p{L}\p{N}]` would refuse it, but each
// regex this is spliced into sets its own flags: built without `u`, `\p` is a
// plain "p" and the class a few literal characters, so "dispatched" scopes
// again, silently.
const UPDATE_TYPE = String.raw`(?<![a-z\d])(?:minors?|majors?|patch(?:es)?)(?![a-z\d])`;

// #1992. Both sentence rows are spelling bans, triggered by the stale
// sentence's own words: "bounding drift" here, a merge verb in
// UNSCOPED_MERGE_SENTENCE below. The same unscoped claim reworded — "keeping
// drift bounded at about one month", "that caps drift at a month" — passes.
// That ceiling is accepted, not missed: the table bans a stale FORM, and a
// reader built to catch rewordings nobody has written is the paraphrase-proof
// pin `.out-of-scope/paraphrase-proof-prose-pins.md` refuses. A longer list of
// trigger words would still be a spelling, only a longer one.
const UNSCOPED_DRIFT_SENTENCE = new RegExp(
  String.raw`(?:^|${SENTENCE_END})(?:(?!${SENTENCE_END}|${UPDATE_TYPE})[^])*\bbounding\s+drift\b(?:(?!${SENTENCE_END}|${UPDATE_TYPE})[^])*(?:${SENTENCE_END}|$)`,
  "i",
);
const UNSCOPED_AUTOMERGED_SPAN = new RegExp(
  String.raw`\*\*(?:(?!${UPDATE_TYPE})[^*\n])*\bautomerged\b(?:(?!${UPDATE_TYPE})[^*\n])*\*\*`,
  "i",
);

// #1978. The merge counterpart of UNSCOPED_DRIFT_SENTENCE, for pin-drift.sh's
// bound row below: a sentence that ties a bump's merge to its checks — merge,
// merges, automerged; checks, CI, green — with no update type named in it.
// Both trigger words sit in lookaheads so either may come first, and the scope
// ban spans the whole sentence, so UPDATE_TYPE anywhere inside it passes —
// rebased onto #1958's shared constant rather than a bare `minor|patch|major`,
// so "dispatched"/"majority" scope nothing here either, same as its drift
// twin. It pins the scope's presence, not its polarity — "every bump, major
// included, merges once the checks pass" names a type and passes — since
// which types automerge is renovate.json's to say, and
// renovate-release-contract.test.mjs already reds a major that automerges.
// The merge trigger is closed with its own `\b`, matching the checks
// trigger's bilateral bounding: `merg` alone left the noun "merger" (an
// unrelated business sense, not a PR merge) free to trip this beside
// "checks"/"CI"/"green", since a word boundary sits before "merg" in "merger"
// too. Bounding it to `merg(?:e[sd]?|ing)` keeps every verb form this needs —
// merge, merges, merged, merging, automerges, automerged — while
// "merger"/"mergers" no longer satisfy it (review finding, PR #1990).
//
// #1992. Its trigger has the drift row's ceiling in merge words: "a bump
// lands once its checks go green" and "the bump is approved once checks are
// green" pass. Widening the verb list buys more spellings, not the concept.
// `land`, the likeliest synonym, is in pin-drift.sh four times already —
// releases "landing inside" the 43 days, a move "LANDED on the branch", the
// pin "lands roughly", bumps that "keep landing" — none shares a sentence
// with a checks/CI/green word, so none would trip even a widened trigger
// here; the row does not guard ADR 0010, but the same widened trigger reds
// its "none landed in the 43 days after — and node here runs `node
// --check`", whose "check" is a flag.
const UNSCOPED_MERGE_SENTENCE = new RegExp(
  String.raw`(?:^|${SENTENCE_END})(?=(?:(?!${SENTENCE_END})[^])*?\b(?:auto-?)?merg(?:e[sd]?|ing)\b)(?=(?:(?!${SENTENCE_END})[^])*?\b(?:checks?|CI|green)\b)(?:(?!${SENTENCE_END}|${UPDATE_TYPE})[^])*(?:${SENTENCE_END}|$)`,
  "i",
);

const FILES = [
  {
    path: ["..", "tests", "arg.test.mjs"],
    stale: [/ledger\.mjs:441/, /board\.mjs:76-79/],
    live: ["tryRun"],
  },
  {
    path: ["..", "tests", "candidates-exit3-prose.test.mjs"],
    stale: [/candidates\.mjs:378/, /\(:390\)/, /\(:424\)/],
    live: ["allFilteredOut", "process.exitCode"],
  },
  {
    path: ["..", "tests", "candidates.test.mjs"],
    stale: [/next-ticket\/SKILL\.md:15/],
    live: ["## 1. Candidates"],
  },
  {
    // #1935. Two citations of `run-merge-bot.md:195` in this file, both
    // pointing at the CI wait rule's shell-timeout-vs-CI-cycle
    // claim, and both already stale before #1895's step-1 fire/poll split
    // moved the target's own numbering again. Banned generally rather than
    // at the one drifted value: a ban on `:195` alone lets `:196` or any
    // other number straight back in, and this file already carried the
    // identical stale number at two independent sites.
    path: ["scripts", "fleet-heartbeat.mjs"],
    // #2667. The header once said run-merge-bot.md's CI gate holds its wait
    // "and re-issuing it", and the several-holds paragraph once called the
    // heartbeat "the same remedy the CI gate reached for". The CI wait holds
    // in one `eval` cell and re-issues nothing. Tolerant of a re-wrap: the
    // comment is hard-wrapped, so either phrase can break across a `//` line.
    stale: [
      /run-merge-bot\.md:\d+/,
      /re-issuing\s+(?:\/\/\s*)?it\b/,
      /same remedy the\s+(?:\/\/\s*)?CI gate/,
    ],
    // The header still cites run-merge-bot.md's CI gate, for its rule that
    // whatever wakes an idle agent is external and may never come — the reason
    // the alarm is an in-process extension and not a watcher. The 300s command
    // deadline and the 5-6 minute CI cycle it once cited went with the hold.
    live: [
      "run-merge-bot.md's CI gate states the same rule as a rule",
    ],
  },
  {
    path: ["..", "tests", "implementer-model-tier.test.mjs"],
    stale: [/member-lifecycle\.md:7/],
    live: ["member-lifecycle.md's"],
  },
  {
    path: ["scripts", "ledger.mjs"],
    // #2516. The `filed` subcommand's isDigits() comment pointed at
    // "(line ~1527)" for the `keyNum` check it mirrors — a line that had
    // already drifted into an unrelated comment. It names the check by its
    // enclosing function now. runDispatchKeyNumFault below holds the cited
    // side: the function and the check still exist under those names.
    stale: [/fleet-plugin-design\.md:200/, /candidates\.mjs:279/, /\blines?\s+~?\d+/],
    live: ["refuseIfCapped", "runDispatch's `keyNum` check"],
  },
  {
    path: ["..", "tests", "ledger.test.mjs"],
    stale: [/fleet-plugin-design\.md:200/],
    live: ["fleet-plugin-design.md's"],
  },
  {
    path: ["scripts", "member-outcomes.mjs"],
    stale: [/board\.mjs:221-232/],
    live: ["board.mjs's"],
  },
  {
    path: ["scripts", "no-undo-audit.sh"],
    stale: [/claim-ticket\.sh:26/],
    live: [`wt=".worktrees/$issue-$slug"`],
  },
  {
    // #2815. The shebang-half comment cited `skills/run-team/SKILL.md:282`
    // for running fleet-run as `node <path>`; that line was unrelated text
    // before the citation was converted. Banned generally, for the reason the
    // run-merge-bot-prose.test.mjs entry gives. The needle is the quoted
    // launch line itself; the run-team references/phase-0.md entry pins that
    // same line on the cited side.
    path: ["..", "tests", "node-floor-sweep.test.mjs"],
    stale: [/SKILL\.md:\d/],
    live: ["`node ~/.fleet/bin/fleet-run board.mjs serve --open &`"],
  },
  {
    path: ["..", "tests", "printf-die-sweep.test.mjs"],
    stale: [/verify-sha\.sh:33/],
    live: ["verify-sha.sh's fetch trace"],
  },
  {
    // #870. Not a #516 conversion: PR #866 fixed these two citations by hand,
    // both `release-ticket.sh:15-25` -> a bare `release-ticket.sh`, and left
    // them unpinned in both directions. Banned generally rather than at the one
    // drifted value, for the reason the run-merge-bot entry below gives: a ban
    // on `:15-25` alone lets `:14-24` straight back in. This file carries no
    // other `release-ticket.sh:<digit>`, so the general form costs nothing
    // today — and it will refuse one thing tomorrow, the same thing
    // net-ssh-precedence-prose.test.mjs's negative pin already refuses and
    // documents: a future sentence in that file recounting what the citation
    // USED to say. Accepted on the same ground — that history belongs on the
    // commit, not in a comment a reader could act on.
    path: ["..", "tests", "reaping-prose.test.mjs"],
    stale: [/release-ticket\.sh:\d/],
    // One needle per SITE — the file header, and the comment inside
    // `test("release-ticket.sh: the comment at the dirty check ...")` — because
    // the finding is that the stale form can return to EITHER of them, and a
    // needle satisfied from one site would not notice the other reverting. A
    // bare `release-ticket.sh` would be vacuous outright: that file names the
    // script in unrelated prose, in a path join and in a test name. Needles
    // this long are the price of that: a copy-edit to either sentence reds
    // here, which is a citation-shaped change asking to be re-read anyway.
    live: [
      "The script's header (release-ticket.sh) already carried the corrected wording",
      "The header (release-ticket.sh) states the limitation",
    ],
  },
  {
    path: ["..", "tests", "release-ticket.test.mjs"],
    stale: [/release-ticket\.sh:303/],
    live: ["empty-entry skip"],
  },
  {
    path: ["..", "tests", "review-core-reads.test.mjs"],
    stale: [/select-dimensions\.test\.mjs:211-216/],
    live: ["reviewDispatchOptions"],
  },
  {
    path: ["..", "tests", "review-core-snapshot-path.test.mjs"],
    // #2546. The test once cited a `required:` comment inside
    // `FINDINGS_SCHEMA` in review-core.mjs, which that file does not carry —
    // the comment lived in the deleted review-pr.js. The stale form is that
    // dangling citation; the live needle is the spec that now holds the quote.
    stale: [/select-dimensions\.test\.mjs:251-256/, /`required:` comment inside `FINDINGS_SCHEMA` in review-core\.mjs/],
    live: ["resolveDimensions", "2026-09-08-omp-eval-workflow-host.md"],
  },
  {
    path: ["..", "tests", "run-merge-bot-prose.test.mjs"],
    // #1136. The line number on this citation rotted repeatedly — #1136
    // measured `:107`, #516 swept `:173`, and the check itself now sits at a
    // third place again — so the stale form is banned generally here rather
    // than one drifted value at a time.
    stale: [/prove-merge\.sh:\d+/],
    // The live needle is the CONSTRUCT, verbatim from that check. The die
    // message the check emits would be a vacuous needle: this file asserts
    // that string independently of the citation, so the pin would still pass
    // after the citation was deleted outright.
    live: ['[ "$parents" -ge 2 ]'],
  },
  // #1349 retired this entry outright rather than leaving it to rot:
  // select-dimensions.test.mjs's `lift(stripComments(SOURCE), "resolveDimensions"...)`
  // machinery this pin guarded no longer exists anywhere in this file —
  // the omp-only cutover converted it to direct imports of
  // `resolveDimensions`/`verifiersFor`/`DEFAULT_DIMENSIONS`, so there is no
  // construct left to name here. Removed with the cutover that obsoleted
  // it, not left as a stale form for a future sweep to catch.
  // #1349 retired this entry outright rather than leaving it to rot: the
  // vendored `code-reviewer.md` this citation pointed at (via its "Review
  // Scope" section) no longer exists anywhere in this port — the fork ruled
  // on #1303 drops the whole `pr-review-toolkit` dependency, so there is no
  // construct left to name here. Removed with the ticket that obsoleted it,
  // not left as a stale form for a future sweep to catch.
  {
    // SKILL.md holds no needle: the cockpit launch line node-floor-sweep.test.mjs
    // cites by its quoted text is pinned on the phase-0.md entry below.
    path: ["skills", "run-team", "SKILL.md"],
    stale: [/board\.mjs:153/],
    live: [],
  },
  // The cockpit launch line and the scrape both moved out of SKILL.md into the
  // reference files, with the paragraphs that carry them.
  {
    path: ["skills", "run-team", "references", "phase-0.md"],
    stale: [/board\.mjs:153/],
    live: ["`node ~/.fleet/bin/fleet-run board.mjs serve --open &`"],
  },
  {
    path: ["skills", "run-team", "references", "close-out.md"],
    stale: [],
    live: ["encodeProjectDir"],
  },
  // #1725 fixed this ADR's `ci.yml:269` citation by hand, replacing it with
  // the `# Blocking, every PR` comment anchor. Ban the general `\d+` form,
  // not just the one drifted value: a ban on `:269` alone lets `:270` right
  // back in.
  //
  // #1916. Two more citations rotted the same way: `release.yml:41` (the
  // false-claim history in Context) and `release-label.yml:39-41` /
  // `release-label.yml:68-70` (the `auto-label-bots` and
  // `validate-release-label` jobs' `if:` conditions, both cited on the same
  // `required_status_checks` table row). Converted to the job/step names,
  // the same construct ADR 0010 already uses for these same two files.
  //
  // #3346. The `allowed_merge_methods` row's prove-merge.sh cites drifted the
  // same way: the die's line and the `:8-9` continuation for the proof header.
  // Converted to the die's message and the header's `secondParentIsHead` gate.
  // The bare `:N` / `:N-M` ban, backticked or not and comma lists included,
  // catches a continuation cite whose file is named earlier in the sentence,
  // which the `file:\d+` forms miss; its `(?<!\w)` lets a timestamp's `12:30`
  // through. The prove-merge.sh ban also takes the file backticked apart from
  // its `:N`, and the `prove-merge.sh line N` prose spelling.
  {
    path: ["..", "docs", "adr", "0007-main-ruleset-is-the-merge-gate.md"],
    stale: [
      /ci\.yml:\d+/,
      /release\.yml:\d+/,
      /release-label\.yml:\d+/,
      /prove-merge\.sh`?\s*(?::|line\s+)\d+/,
      /(?<!\w)`?:\d+(?:[-,]\d+)*`?/,
    ],
    live: [
      "# Blocking, every PR",
      "`release.yml`'s `Determine bump segment` step",
      "`release-label.yml`'s `auto-label-bots` job",
      "`release-label.yml`'s `validate-release-label` job",
      "`has no second parent — not a merge commit` die",
      "`secondParentIsHead` gate",
    ],
  },
  // #1756. ADR 0010's own evidence, corrected in place. Its ci.yml citation
  // named the `node-version-file` sites by line, numbers the introducing PR's
  // own hunk had already shifted; 8ec241f, in that same PR, named the jobs
  // holding them instead. Its claim-ticket.test.mjs citation landed on a
  // comment above the assertions it describes, and now names the test by its
  // title. Its candidates.mjs citations for the query and the fallback retry
  // pointed at comment lines even at the ADR's own commit, and now name
  // `query()` and the retry's `query(null)`. Each of those line forms is
  // banned generally, for the reason the ADR 0007 entry gives. The remaining
  // stale forms are not citations but the same rot, the widening #1555 made:
  // a parseArgs caller list crediting arg.mjs and staleness.mjs, whose
  // mentions are comments; a Node release date a day earlier than the
  // changelog's; and an escape-hatch sentence that ruled out every other hatch
  // rather than every other Renovate-driven one. None of those was replaced
  // by a construct, so they carry no live needle — pinning the new wording
  // instead would red a legitimate reword.
  //
  // #1872. The three citations #1756 left in line form, all in the same
  // evidence list: `board-cli.test.mjs`'s 100-run measurement, and the
  // `release.yml` / `release-label.yml` citations behind "every merged PR
  // mints a release". The board-cli one had already rotted when this ticket
  // reached it — later edits to that file had moved the measurement out of the
  // cited range, and nothing went red. Each now names its construct instead —
  // the test the measurement sits above, and each workflow's job — and each
  // line form is banned generally, for the same reason.
  //
  // #1874. Two more of the same, adjacent to #1756's. The Status line and a
  // Consequences bullet located the pin's owner comment in ci.yml as the
  // "first" `setup-node`, a position any `setup-node` step added above the
  // `check` job's would silently re-point it to; both now name the `check`
  // job instead.
  // One needle serves both sites, so it is the ban on the positional form, not
  // the needle, that reds either one reverting. And the evidence counted "8
  // releases" and a security release "since the pin" without saying from
  // what: 8 is the releases past `26.5.0`, three of them — the security
  // release among them — already out when the pin was set. Both were bans on
  // the old sentence's spelling, and the same false claim in other words
  // passed each. Neither claim is read for what it says: a reader built to
  // catch rewordings nobody has written is the paraphrase-proof pin
  // `.out-of-scope/paraphrase-proof-prose-pins.md` refuses.
  //
  // #1905. The release-age gate, stated in wall-clock days it does not give.
  // The Status line's #1753 amendment said a release "must be three days old"
  // before the bot acts, and point 3 (as #1900 left it) put the shortfall at
  // "closer to two days", from a date that sits "hours to a day before" the
  // publish. Renovate's `node-version` datasource reads index.json's day-only
  // `date` as UTC midnight; across all 15 v26.x releases that midnight sat 12
  // to 38.5 hours before the GitHub release, so the gate can pass a release
  // 33.5 hours after it went out. All three wordings are banned. The third
  // row also bans "up to a day before"; #1905's own suggested remedy said the
  // datasource can "precede actual publish by up to a day", which undercounts
  // the same gap the same way and gets its own fourth row below, since it
  // drops the trailing "before" the third row's alternation needs. No live
  // needle, for the reason #1756's gives.
  //
  // #1906. Point 3's bold heading ("Monthly, and automerged.") and its
  // closing figures ("about one PR, one release and one CI burst per month
  // ... bounding drift at about one month") read as covering every bump,
  // where the Status line's #1752 amendment keeps automerge for minor and
  // patch bumps only: a major waits for a human, so its release waits on that
  // human and no one-month drift bound holds for it. Both now name their
  // scope. The two rows #1906 adds ban each claim with no update type —
  // minor, patch or major — named in its own span: a one-line bold span that
  // says automerged, and a sentence bounding drift. The scope has to sit in
  // that span, for the reason ci-comment-rot-prose's windowClaimFault keeps
  // its distinction inside one sentence: read any wider, an unrelated mention
  // nearby supplies it. The cost of that ceiling is that a paraphrase scoping
  // the claim only in the NEXT sentence reds too — and so does one scoping it
  // across a mid-sentence period SENTENCE_END still counts as an end: "etc.",
  // an ellipsis, any abbreviation off its list (#1959). No live needle, for
  // the reason #1756's gives.
  {
    path: ADR_0010,
    stale: [
      /\blines?\s+\d/,
      /claim-ticket\.test\.mjs:\d/,
      /candidates\.mjs:\d/,
      /board-cli\.test\.mjs:\d/,
      /release\.yml:\d/,
      /release-label\.yml:\d/,
      /\bfirst\s+`?setup-node\b/,
      // A backticked `.mjs` list straight after "used by" that includes either
      // comment-only file, wherever in the list and however it wraps.
      /used by(?:[\s,]*(?:and\s+)?`[\w-]+\.mjs`)*[\s,]*(?:and\s+)?`(?:arg|staleness)\.mjs`/,
      /2026-09-21/,
      /there is no other(?!\s+Renovate-driven\b)/,
      /must\s+be\s+three\s+days\s+old/,
      /closer\s+to\s+two\s+days/,
      /(?:hours|up)\s+to\s+a\s+day\s+before/,
      /\bby\s+up\s+to\s+a\s+day\b/,
      UNSCOPED_AUTOMERGED_SPAN,
      UNSCOPED_DRIFT_SENTENCE,
    ],
    live: [
      "`check`",
      "`validate-claude`",
      "`install-and-smoke`",
      "runner: a dash-led argument counts as an operand only where it exists",
      "`query()`",
      "`query(null)`",
      "build: --spend-since's refusal survives a gh child that has already pushed past the pipe buffer, unread",
      "`release.yml`'s `release` job",
      "`release-label.yml`'s `auto-label-bots` job",
      "the `check` job's `setup-node`",
    ],
  },
  // #1874. pin-drift.sh restated ADR 0010's "43 days across 8 releases" as
  // the cost of a silent pin, where only five of the 8 landed inside the 43
  // days. The count is corrected in both files.
  //
  // #1925. The bound's argument in pin-drift.sh, and the cadence note in
  // pin-drift.yml that leans on it, still described the Renovate schedule
  // #1753 replaced: the 1st of each month, 00:00–04:59 UTC. The window is now
  // all day on the 1st–3rd, so the longest healthy gap is no longer "up to 31
  // days", 35 leaves about a day of slack rather than "a few days'", and a
  // Monday run on the 1st–3rd falls inside the window rather than "never"
  // racing it. Each stale wording is banned in the file that carried it, and
  // `(?:\s|#)+` spans a wrap across the `# ` gutter. No
  // live needle: the replacement states the window renovate.json owns, and
  // pinning it would red a legitimate schedule change, not the stale copy.
  //
  // #1978. The same argument added that last PR's checks to the gap "since
  // the merge waits on them, not on the window" — every bump's merge, as
  // #1956 found ci.yml saying, when #1752 had narrowed automerge to minor and
  // patch: a major waits on a human, which no drift bound covers. The bound
  // stays at 35 (the script now argues why a pending major needs no slack);
  // the row bans a merge-on-checks sentence that names no update type, and
  // SENTENCE_END finds the sentence across the `# ` gutter as it does in the
  // ADR. No live needle, for #1756's reason.
  {
    path: PIN_DRIFT_SH,
    stale: [
      /\b1st(?:\s|#)+of(?:\s|#)+each(?:\s|#)+month\b/,
      /\b1st-to-1st\b/,
      /\bup(?:\s|#)+to(?:\s|#)+31(?:\s|#)+days\b/,
      /\ba(?:\s|#)+few(?:\s|#)+days'(?:\s|#)+slack\b/,
      UNSCOPED_MERGE_SENTENCE,
    ],
    live: [],
  },
  {
    path: ["..", ".github", "workflows", "pin-drift.yml"],
    stale: [
      /\b1st(?:\s|#)+of(?:\s|#)+each(?:\s|#)+month\b/,
      /00:00(?:\s|#)*[–-](?:\s|#)*04:59/,
      /\bnever(?:\s|#)+races\b/,
    ],
    live: [],
  },
  // #1757. The glossary's Runtime heading names the two terms ADR 0010
  // separates, and each entry points at that ADR from its cross-reference to
  // the other term. One needle per SITE, for the reason the reaping-prose
  // entry gives: a bare `(ADR 0010)` would stay satisfied by either entry
  // after the other lost its pointer. Those two are new pointers, not
  // converted ones, so neither has a stale form.
  //
  // #2764. The Cell and Admissible row entries each carried a "pending
  // `#N`, not yet built" pointer that outlived its ticket's close: the
  // definitions and `stoppingRule` had shipped. The pointers are converted
  // to name what was built, so the stale forms are banned here and the
  // stopping rule's export is the construct the entry still has to name. The
  // bans match the pointer with or without its backticks and in any case, so
  // a plain "pending #2134" or a sentence-initial "Pending `#2134`" revert
  // is caught as well.
  {
    path: ["..", "CONTEXT.md"],
    stale: [/\bpending\s+`?#2129(?!\d)`?/i, /\bpending\s+`?#2134(?!\d)`?/i],
    live: ["**Consumer floor** (ADR 0010)", "**Runtime pin** (ADR 0010)", "`stoppingRule`"],
  },
];

for (const { path, stale, live } of FILES) {
  const label = path.join("/");
  const source = read(...path);
  const prose = normalize(source);

  for (const pattern of stale) {
    test(`${label} does not regress to the stale form ${pattern}`, () => {
      assert.doesNotMatch(
        source,
        pattern,
        `a stale form matching ${pattern} is back in ${label} — this spelling was converted away because it rots silently: a line number the moment the cited file is next touched, a raw-source pin the moment a dead copy drifts above the live declaration — with nothing going red when it does`,
      );
    });
  }

  for (const needle of live) {
    test(`${label} still names the construct its citation rests on (${needle})`, () => {
      assert.ok(
        prose.includes(needle),
        `${label} no longer mentions "${needle}" anywhere — the construct this citation rests on appears to have been deleted outright rather than kept current`,
      );
    });

    for (const [, number] of needle.matchAll(ADR_POINTER)) {
      test(`${label}'s pointer to ADR ${number} still resolves to one file under docs/adr/ (${needle})`, () => {
        const fault = adrFault(number, ADRS);
        assert.equal(fault, null, `${label} points at ADR ${number} through "${needle}", but ${fault}`);
      });
    }
  }
}

// The cited side of ledger.mjs's "runDispatch's `keyNum` check" pointer: a
// top-level `function runDispatch(` (`async` or not) whose body, up to the
// first line that starts with `}`, still calls `isDigits(keyNum)`. Comments
// are stripped first, so the pointer's own comment, or the check left behind
// as a whole-line `//` or `/* */` comment, cannot stand in for the code, and
// KEYNUM_CHECK refuses a check that follows a `//` on its line. Two forms
// still can, because strip-comments.mjs blanks whole-line comments only and
// nothing here tokenizes: the check's text inside a string literal, and
// inside a block comment opened after code on the same line. Null when the
// function and the call both hold, else the reason.
const RUN_DISPATCH = /^(?:async\s+)?function\s+runDispatch\s*\(/m;
const KEYNUM_CHECK = /^(?:(?!\/\/).)*\bisDigits\(\s*keyNum\s*\)/m;

function runDispatchKeyNumFault(source) {
  const code = stripComments(source);
  const start = code.search(RUN_DISPATCH);
  if (start === -1) return "no `function runDispatch(` outside comments";
  const end = code.indexOf("\n}", start);
  const body = code.slice(start, end === -1 ? undefined : end);
  return KEYNUM_CHECK.test(body) ? null : "runDispatch() no longer calls `isDigits(keyNum)` outside comments";
}

test("ledger.mjs's pointer to runDispatch's `keyNum` check still lands on code", () => {
  const fault = runDispatchKeyNumFault(read("scripts", "ledger.mjs"));
  assert.equal(fault, null, `ledger.mjs's \`filed\` comment points at "runDispatch's \`keyNum\` check", but ${fault} — rename the pointer with its target, and RUN_DISPATCH and KEYNUM_CHECK in citation-sweep-prose.test.mjs with it`);
});

test("the runDispatch pointer reds once the function, the variable or the check's place changes", () => {
  const check = "  const keyNum = key;\n  if (!isDigits(keyNum)) die();\n";
  for (const source of [
    `function runDispatchRow() {\n${check}}\n`,
    "function runDispatch() {\n  const keyDigits = key;\n  if (!isDigits(keyDigits)) die();\n}\n",
    `function runDispatch() {\n}\n\nfunction validate() {\n${check}}\n`,
    "function runDispatch() {\n  const keyNum = key;\n  // if (!isDigits(keyNum)) die();\n}\n",
    "function runDispatch() {\n  const keyNum = key;\n  void 0; // if (!isDigits(keyNum)) die();\n}\n",
    `/*\nfunction runDispatch() {\n${check}}\n*/\n`,
    `function wrapper() {\n  function runDispatch() {\n${check}  }\n}\n`,
    `const x = 1; function runDispatch() {\n${check}}\n`,
  ]) {
    assert.notEqual(runDispatchKeyNumFault(source), null, source);
  }
});

test("the runDispatch pointer accepts a reflowed check and ignores the comment that cites it", () => {
  for (const source of [
    "// isDigits() gates id the same way runDispatch's `keyNum` check gates\nasync function runDispatch() {\n  if (keyNum !== null && !isDigits( keyNum )) die();\n}\n",
    "function runDispatch() {\n  const keyNum = key;\n  if (!isDigits(keyNum)) die();\n}\n",
  ]) {
    assert.equal(runDispatchKeyNumFault(source), null, source);
  }
});

test("an ADR pointer resolves by number alone, so a retitled ADR still answers to it", () => {
  assert.equal(adrFault("0010", ["0009-supported-platforms-are-macos-linux-wsl.md", "0010-a-retitled-ruling.md"]), null);
});

test("an ADR pointer reds once its number stops naming exactly one file: renumbered, moved out, or doubled", () => {
  assert.match(adrFault("0010", ["0009-supported-platforms-are-macos-linux-wsl.md", "0014-the-node-pin-stays-exact-and-a-bot-moves-it.md"]), /no docs\/adr\/0010-\*\.md/);
  assert.match(adrFault("0010", []), /no docs\/adr\/0010-\*\.md/);
  assert.match(adrFault("0010", ["0010-one-ruling.md", "0010-another-ruling.md"]), /2 files answer to ADR 0010/);
});

test("an unscoped drift sentence is refused, whatever ends the sentence before it (#1957)", () => {
  for (const text of [
    // Point 3's figures sentence as it read before #1906.
    [
      "   gives the measurement.",
      "   That keeps about one PR, one release and one CI burst per month — the",
      "   Status line's #1753 amendment names one case that opens a second — while",
      "   bounding drift at about one month.",
    ].join("\n"),
    // The case #1957 was filed on: a scoped bold heading ending `bumps.**`.
    "3. **Monthly, and automerged for minor and patch bumps.**\n   Bounding drift at about one month.\n",
    "_Monthly for minor and patch bumps._ Bounding drift at about one month.\n",
    "Minor and patch bumps follow `schedule: monthly.` Bounding drift at about one month.\n",
    "Minor and patch bumps land monthly (see `renovate.json`.) Bounding drift at about one month.\n",
    "[Minor and patch bumps only.] Bounding drift at about one month.\n",
    'Renovate calls minor and patch bumps "monthly." Bounding drift at about one month.\n',
    "Renovate calls minor and patch bumps 'monthly.' Bounding drift at about one month.\n",
    "Renovate calls minor and patch bumps “monthly.” Bounding drift at about one month.\n",
    "Renovate calls minor and patch bumps ‘monthly.’ Bounding drift at about one month.\n",
    "**Why automerge minor and patch bumps?** Bounding drift at about one month.\n",
    "Minor and patch bumps merge themselves! Bounding drift at about one month.\n",
    "## Minor and patch bumps\n\nBounding drift at about one month.\n",
    "- Monthly for minor and patch bumps\n- Bounding drift at about one month.\n",
    // The other two markers SENTENCE_END's `[-*+]` list-item lookahead
    // allows — each is its own branch, not implied by `-` alone.
    "* Monthly for minor and patch bumps\n* Bounding drift at about one month.\n",
    "+ Monthly for minor and patch bumps\n+ Bounding drift at about one month.\n",
  ]) {
    assert.match(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

test("a drift sentence naming its own scope passes, whatever markup it carries and however it wraps (#1957)", () => {
  for (const text of [
    // Closing markup ends nothing without a terminator before it, and a
    // terminator ends nothing without whitespace after it.
    "For **minor** and _patch_ bumps (automerged) under `renovate.json`, bounding drift at about one month.\n",
    "For minor and patch bumps past v26.5.0, bounding drift at about one month.\n",
    // A lone newline is a wrap, not an end — even before an issue number or
    // a bold span, which open no heading and no list item.
    "For a minor or patch bump, the Status line's\n   #1753 amendment names one case, and\n   **automerge** keeps\n   bounding drift at about one month.\n",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

test("an unscoped drift sentence is refused after every block end and closing markup #1957 left out (#1981)", () => {
  for (const text of [
    // The three cases #1981 was filed on.
    "1) Monthly for minor and patch bumps\n2) Bounding drift at about one month.\n",
    "> Minor and patch bumps\n>\n> Bounding drift at about one month.\n",
    "Minor and patch bumps merge monthly…Bounding drift at about one month.\n",
    "Minor and patch bumps\r\n\r\nBounding drift at about one month.\r\n",
    // The same blank line behind pin-drift.sh's `# ` gutter, and a list item
    // behind either gutter.
    "# Minor and patch bumps\n#\n# Bounding drift at about one month.\n",
    "> - Minor and patch bumps\n> - Bounding drift at about one month.\n",
    "# 1) Minor and patch bumps\n# 2) Bounding drift at about one month.\n",
    // A multi-digit ordered item marker — the digit branch is `\d{1,9}`,
    // not just a single digit (PR #1998 review, fleet-review-tests).
    "100) Monthly for minor and patch bumps\n101) Bounding drift at about one month.\n",
    // A line holding only a setext underline or thematic break — each
    // character its own case, since `* ` and `- ` would open a list item
    // instead — then a code fence and a table row.
    "Minor and patch bumps\n===\nBounding drift at about one month.\n",
    "Minor and patch bumps\n---\nBounding drift at about one month.\n",
    "Minor and patch bumps\n***\nBounding drift at about one month.\n",
    "Minor and patch bumps\n___\nBounding drift at about one month.\n",
    "Minor and patch bumps\n```\nbounding drift at about one month.\n```\n",
    "Minor and patch bumps\n~~~\nbounding drift at about one month.\n~~~\n",
    "| Minor and patch bumps |\n| Bounding drift at about one month. |\n",
    // Closing markup past the class #1957 added.
    "~~Minor and patch bumps only.~~ Bounding drift at about one month.\n",
    "Renovate calls minor and patch bumps «monthly.» Bounding drift at about one month.\n",
    "Renovate calls minor and patch bumps ‹monthly.› Bounding drift at about one month.\n",
    "Minor and patch bumps set `{schedule: monthly.}` Bounding drift at about one month.\n",
    "Minor and patch bumps land monthly <see renovate.json.> Bounding drift at about one month.\n",
    "<b>Minor and patch bumps only.</b> Bounding drift at about one month.\n",
  ]) {
    assert.match(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

test("a scoped drift sentence still wraps behind a gutter, over CRLF, past `...` and a leading number (#1981)", () => {
  for (const text of [
    // A lone newline behind a gutter is a wrap, as it is without one.
    "> For minor and patch bumps, the gap keeps\n> bounding drift at about one month.\n",
    "# For minor and patch bumps, the gap keeps\n# bounding drift at about one month.\n",
    "For minor and patch bumps, the gap keeps\r\nbounding drift at about one month.\r\n",
    // Three periods inside a range end nothing; only `…` needs no whitespace.
    "For minor and patch bumps, `main...HEAD` keeps bounding drift at about one month.\n",
    // A number opens a list item only with its `.` or `)` and a space.
    "For minor and patch bumps the gap runs\n35 days, bounding drift at about one month.\n",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

test("an unscoped drift sentence is refused after an HTML block or blockquote opens, a short setext underline, and a link or footnote (#2002)", () => {
  for (const text of [
    // The cases #2002 was filed on that read past a real end.
    "Minor and patch bumps\n<div>\nBounding drift at about one month.\n",
    "Minor and patch bumps\n> Bounding drift at about one month.\n",
    "[Minor and patch bumps only.](renovate.json) Bounding drift at about one month.\n",
    "<my-el>Minor and patch bumps only.</my-el> Bounding drift at about one month.\n",
    "<b>Minor and patch bumps only.</b > Bounding drift at about one month.\n",
    // The HTML block's other openers: a closing block tag, a comment, a
    // type-1 tag outside the block tag list.
    "Minor and patch bumps\n</details>\nBounding drift at about one month.\n",
    "Minor and patch bumps\n<!-- monthly -->\nBounding drift at about one month.\n",
    "Minor and patch bumps\n<pre>\nBounding drift at about one month.\n",
    // The rest of HTML_BLOCK_OPEN's own openers: the other type-1 tags, a
    // processing instruction, a doctype, a CDATA section, and a block tag's
    // self-closing boundary.
    "Minor and patch bumps\n<script>\nBounding drift at about one month.\n",
    "Minor and patch bumps\n<?php\nBounding drift at about one month.\n",
    "Minor and patch bumps\n<!DOCTYPE html>\nBounding drift at about one month.\n",
    "Minor and patch bumps\n<![CDATA[x]]>\nBounding drift at about one month.\n",
    "Minor and patch bumps\n<hr/>\nBounding drift at about one month.\n",
    // A quote opening behind pin-drift.sh's `# ` gutter.
    "# Minor and patch bumps\n# > Bounding drift at about one month.\n",
    // A `#`-gutter rule line or gutter list item, with no space after the
    // `#`, still ends the sentence — the digit-only exception #2002 needs.
    "# Minor and patch bumps\n#------------------------------\n# Bounding drift at about one month.\n",
    "# Minor and patch bumps\n#- Bounding drift at about one month.\n",
    // What still ends at the underline: a setext run of one, a spaced break,
    // three spaces of indent.
    "Minor and patch bumps\n-\nBounding drift at about one month.\n",
    "Minor and patch bumps\n_ _ _\nBounding drift at about one month.\n",
    "Minor and patch bumps\n   ===\nBounding drift at about one month.\n",
    // A reference link's label and a footnote reference close a sentence too.
    "[Minor and patch bumps only.][renovate] Bounding drift at about one month.\n",
    "Minor and patch bumps only.[^1] Bounding drift at about one month.\n",
  ]) {
    assert.match(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

test("a scoped drift sentence still wraps past an inline tag, a line CommonMark renders as prose, and a `#NNNN)` citation (#2002)", () => {
  for (const text of [
    // Not an HTML block: a tag outside the block list, or a block tag's name
    // as the prefix of a longer one.
    "For minor and patch bumps, the gap keeps\n<span>\nbounding drift at about one month.\n",
    "For minor and patch bumps, the gap keeps\n<divider>\nbounding drift at about one month.\n",
    // Neither a setext underline nor a thematic break.
    "For minor and patch bumps, the gap keeps\n_\nbounding drift at about one month.\n",
    "For minor and patch bumps, the gap keeps\n**\nbounding drift at about one month.\n",
    "For minor and patch bumps, the gap keeps\n-=-\nbounding drift at about one month.\n",
    "For minor and patch bumps, the gap keeps\n*-_\nbounding drift at about one month.\n",
    "For minor and patch bumps, the gap keeps\n    ---\nbounding drift at about one month.\n",
    // An issue citation wrapped to a line's start, with or without a gutter.
    "For minor and patch bumps (see\n#1906) the gap keeps bounding drift at about one month.\n",
    "# For minor and patch bumps (see\n# #1906) the gap keeps bounding drift at about one month.\n",
    // A link ends nothing without a terminator inside it.
    "For minor and patch bumps [the gap](renovate.json) keeps bounding drift at about one month.\n",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

test("a word that only contains minor, patch or major scopes neither claim (#1958)", () => {
  for (const text of [
    // Point 3's heading as it read before #1906.
    "3. **Monthly, and automerged.**\n",
    "**Monthly, and automerged; dispatched by the bot.**",
    "**Dispatched monthly, and automerged.**",
    "**Monthly, and automerged for the majority of bumps.**",
    "**Monthly, and automerged once patched.**",
    // Ends in "patch": only the boundary BEFORE the word refuses it.
    "**Monthly, and automerged on each dispatch.**",
  ]) {
    assert.match(text, UNSCOPED_AUTOMERGED_SPAN, text);
  }
  for (const text of [
    "For the majority of bumps that keeps one PR while bounding drift at a month.\n",
    "Bounding drift at about one month, dispatched by the bot.\n",
    "Once patched, bounding drift at about one month.\n",
    "Bounding drift at about one month for a minority of releases.\n",
    "Bounding drift at about one month, whatever Renovate dispatches.\n",
  ]) {
    assert.match(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

test("minor, patch or major still scopes both claims in italics or as a plural (#1958)", () => {
  for (const text of [
    "3. **Monthly, and automerged for minor and patch bumps.**\n",
    "**Monthly, and automerged for _patch_ bumps.**",
    "**Monthly, and automerged for minors and patches.**",
    "**Majors wait; the rest are automerged.**",
    // Italic and plural at once (#1989): the `_` beside the word and the
    // plural's "es"/"s" meet in one token, before and after the claim.
    "**Monthly, and automerged for _patches_.**",
    "**_Majors_ wait; the rest are automerged.**",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_AUTOMERGED_SPAN, text);
  }
  for (const text of [
    "For _patch_ bumps, bounding drift at about one month.\n",
    "Bounding drift at about one month for minors and patches.\n",
    "Majors aside, bounding drift at about one month.\n",
    "Bounding drift at about one month for _patches_.\n",
    "_Minors_ aside, bounding drift at about one month.\n",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

// Pins #1988's accepted plain-English hole, not a bug: a whole word cannot
// tell the verb "patches" or "patch", or the adjective "minor" or "major",
// from the update type, so each still scopes its claim. A change that closes
// the hole should fail here; one that widens it instead fails #1958's "a word
// that only contains…" test above, since that is the row already pinning
// which inflected forms of "patch" scope nothing. Either way, update
// UPDATE_TYPE's comment with it (#1989).
test("minor, patch or major in its plain-English sense still scopes all three claims, as documented (#1989)", () => {
  for (const text of [
    "**Renovate patches the automerged bumps.**",
    "**We patch monthly, and the bumps are automerged.**",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_AUTOMERGED_SPAN, text);
  }
  for (const text of [
    "Renovate patches each dependency, bounding drift at about one month.\n",
    "At minor cost, bounding drift at about one month.\n",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
  for (const text of [
    "# Renovate patches the lockfile, and the bump merges once CI goes green.\n",
    "# A major benefit: the bump merges once CI goes green.\n",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_MERGE_SENTENCE, text);
  }
});

test("a merge-on-checks sentence naming no update type is refused, across the gutter and in either word order (#1978)", () => {
  for (const text of [
    // pin-drift.sh's bound argument as it read before #1978.
    [
      "# monthly. The longest healthy gap runs from a bump PR opened as one window",
      "# opens on the 1st to the next one opened as its window closes at the end of",
      "# the 3rd — up to 34 days across a 31-day month, and a hosted run that comes",
      "# late inside the window is already inside that figure — plus however long",
      "# that last PR's checks take to go green, since the merge waits on them, not",
      "# on the window. 35 days leaves about a day for those checks.",
    ].join("\n"),
    "# The bump automerges once CI goes green.\n",
    "# Once the checks pass, the bump PR merges itself.\n",
    // UPDATE_TYPE's word boundary, not a bare substring test: "dispatch" and
    // "majority" contain no whole minor/patch/major token (#1958).
    "# The bump merges once CI goes green, as a workflow_dispatch run shows.\n",
    "# The bump merges once CI goes green, in the majority of months.\n",
    // The ceiling: the next sentence's scope does not reach back.
    "# Its merge waits on the checks, not the window. A major waits on a human too.\n",
  ]) {
    assert.match(text, UNSCOPED_MERGE_SENTENCE, text);
  }
});

test("a merge-on-checks sentence naming its scope passes, as does a sentence with only one of merge and checks (#1978)", () => {
  for (const text of [
    [
      "# that last PR's checks take to go green, since a minor or patch bump is",
      "# automerged and its merge waits on them, not on the window.",
    ].join("\n"),
    "# A major's merge waits on a human as well as its checks.\n",
    // pin-drift.sh's own neighbours: a merge commit with no checks, and
    // checks with no merge — neither says what a bump's merge waits on.
    "# `--first-parent` dates the move by when it LANDED on the branch (the merge\n# commit), not by when the bot authored it: a bump PR that sat red for a week\n# has not moved the pin for that week.\n",
    "# 35 days leaves about a day for those checks; a bump PR that goes red and\n# stays red longer than that trips it in such a month.\n",
    // The unrelated business sense of "merger" starts with the same four
    // letters as "merge" — a bare `\b(?:auto-?)?merg` would trip here too,
    // since a word boundary sits before "merg" in "merger" as well (review
    // finding, PR #1990). Bounding the trigger to a real verb form excludes it.
    "# The merger of the checks team and CI team went smoothly and green-lit.\n",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_MERGE_SENTENCE, text);
  }
});

test("the merge trigger only fires on a real merge verb, not a word that merely starts with it (#1990)", () => {
  // "merger" (an unrelated business sense) starts with the same four letters
  // as "merge" — a bare `\bmerg` trigger with no closing boundary would trip
  // beside "checks"/"CI"/"green" here too, since a word boundary sits before
  // "merg" in "merger" as well.
  assert.doesNotMatch(
    "# The merger of the checks team and CI team went smoothly and green-lit.\n",
    UNSCOPED_MERGE_SENTENCE,
  );
});
test("a drift sentence scoped across an abbreviation passes — its period ends no sentence (#1959)", () => {
  for (const text of [
    // The case #1959 was filed on: the scope before "e.g.", the claim after.
    "For a minor bump, e.g. 26.6, that keeps one PR while bounding drift at a month.\n",
    // And the scope after it, the claim before.
    "Bounding drift at about one month, i.e. for minor and patch bumps.\n",
    "For minor bumps (cf. the Status line) bounding drift at about one month.\n",
    "For patch bumps, viz. 26.5.x, bounding drift at about one month.\n",
    "For a minor bump (a small vs. a big change) bounding drift at about one month.\n",
    // Closing markup after the abbreviation, as after any other terminator.
    "For minor bumps (e.g.) bounding drift at about one month.\n",
    "For minor bumps, **e.g.** 26.6, bounding drift at about one month.\n",
    // `_` is a word character, so a `\b` before the abbreviation would miss
    // an italic one, as #1958 found for an italic `_patch_`.
    "For minor bumps, _e.g._ 26.6, bounding drift at about one month.\n",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

test("a period after \"etc.\", or after a word only ending in an abbreviation's letters, still ends the sentence (#1959)", () => {
  for (const text of [
    // "etc." ends a sentence as often as not, so it is off the list: skipping
    // it would lend this claim the scope of the sentence before it.
    "Minor and patch bumps, the lockfile, etc. Bounding drift at about one month.\n",
    // "devs." is not "vs.".
    "Minor and patch bumps are for the devs. Bounding drift at about one month.\n",
    // A digit disqualifies it exactly as a letter does (review finding, PR
    // #1993): narrowing the boundary to `(?<![a-z])` alone still passes every
    // other case here, so nothing else in this file pins the digit half.
    "Minor bumps land in 26vs. Bounding drift at about one month.\n",
  ]) {
    assert.match(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
});

test("a period after a capitalized abbreviation lookalike still ends the sentence, in both rows (#2021)", () => {
  // "Vs." is not "vs.": the rows match case-insensitively, and the list used
  // to fold with them, so a proper noun ending a sentence was read as the
  // abbreviation and the sentence before lent the claim its scope — the
  // silent direction. sentences() matches the list lowercase only (#1899).
  for (const word of ["Vs.", "VS.", "E.g.", "I.e.", "Cf.", "Viz."]) {
    assert.match(`Minor and patch bumps are for the ${word} Bounding drift at about one month.\n`, UNSCOPED_DRIFT_SENTENCE, word);
    assert.match(`# Minor and patch bumps are for the ${word} The bump merges once CI goes green.\n`, UNSCOPED_MERGE_SENTENCE, word);
  }
  // The accept side, in the same fixture shape: lowercase stays one sentence.
  for (const abbr of ["vs.", "e.g.", "i.e.", "cf.", "viz."]) {
    assert.doesNotMatch(`Minor and patch bumps are for the ${abbr} Bounding drift at about one month.\n`, UNSCOPED_DRIFT_SENTENCE, abbr);
    assert.doesNotMatch(`# Minor and patch bumps are for the ${abbr} The bump merges once CI goes green.\n`, UNSCOPED_MERGE_SENTENCE, abbr);
  }
  // Only the list itself stopped folding: the letter-or-digit guard before it
  // still reads a capital — by folding until #2043, by spelling both cases
  // since — so a capital glued to a lowercase abbreviation disqualifies it
  // just as "devs." does, and the sentence ends. Both ends of the list.
  for (const word of ["Ee.g.", "DEvs."]) {
    assert.match(`Minor and patch bumps are for the ${word} Bounding drift at about one month.\n`, UNSCOPED_DRIFT_SENTENCE, word);
  }
});

test("a capitalized abbreviation mid-sentence ends the sentence too — the cost of matching lowercase only (#2021)", () => {
  // Loud here: the scope before the parenthetical drops out of the claim's
  // sentence, and a scoped drift sentence is refused. No file's prose spells
  // one capitalized; the pin is here so a change to the list meets it.
  assert.match("For minor bumps (Cf. the Status line) bounding drift at about one month.\n", UNSCOPED_DRIFT_SENTENCE);
});

test("SENTENCE_END's abbreviation guard reads a capital the same with or without `i` (#2043)", () => {
  // The guard names both cases itself, so no consumer's flag decides whether
  // "DEvs." is "vs.".
  for (const flags of ["", "i"]) {
    for (const word of ["Xvs.", "Ee.g.", "DEvs."]) {
      assert.deepEqual(`for the ${word} Next`.split(new RegExp(SENTENCE_END, flags)), [`for the ${word.slice(0, -1)}`, "Next"], `${word} /${flags}`);
    }
    assert.deepEqual("for the vs. Next".split(new RegExp(SENTENCE_END, flags)), ["for the vs. Next"], `vs. /${flags}`);
  }
});

// #2027: sentences() (prose-pin.mjs) ends a sentence behind a bare footnote
// marker since #1987, and SENTENCE_END took only the caret form `[^1]`, so
// the two read `only.[1] Next` differently. Each shape below is checked with
// and without `i`, since SENTENCE_END is spliced into patterns of both kinds.
test("SENTENCE_END ends a sentence behind a bare footnote marker, as sentences() does, and still behind `[^1]` (#2027)", () => {
  for (const flags of ["", "i"]) {
    const split = (text) => text.split(new RegExp(SENTENCE_END, flags));
    // The ticket's repro, and the caret form beside it.
    assert.deepEqual(split("Bounding drift, only.[1] Elsewhere more."), ["Bounding drift, only", "Elsewhere more."], `[1] /${flags}`);
    assert.deepEqual(split("Bounding drift, only.[^1] Elsewhere more."), ["Bounding drift, only", "Elsewhere more."], `[^1] /${flags}`);
    // Whatever closes before the terminator: a word, a non-ASCII letter, a
    // digit, a code span, a paren, a curly quote. Any terminator, a named
    // marker, a run of markers, closing markup after.
    for (const [text, first] of [
      ["a café.[1] Next", "a café"],
      // A capital, which the guard names itself, as #2043's does.
      ["ran on CI.[1] Next", "ran on CI"],
      ["only 26.[1] Next", "only 26"],
      ["run `jq`.[1] Next", "run `jq`"],
      ["(see above).[1] Next", "(see above)"],
      ["said \u201cstop\u201d.[1] Next", "said \u201cstop\u201d"],
      ["it said \u2018stop\u2019.[1] Next", "it said \u2018stop\u2019"],
      ["done?[note] Next", "done"],
      ["done![1] Next", "done"],
      ["only.[1][2] Next", "only"],
      ["**only.[1]** Next", "**only"],
      // The caret form behind a closer the bare marker's guard refuses: it
      // stays closing markup, as #2002 left it.
      ["**only**.[^1] Next", "**only**"],
    ]) {
      assert.deepEqual(split(text), [first, "Next"], `${text} /${flags}`);
    }
  }
});

test("SENTENCE_END ends nothing at a jq, JavaScript or glob index quoted after a period (#2027)", () => {
  // The code shapes #1987 measured a bare `\[[^\]]*\]` splitting: behind a
  // quote, a `?`, a `*`, or behind a word with an empty or comma-spaced
  // bracket.
  for (const flags of ["", "i"]) {
    for (const text of [
      "jq '.[] | select(.x)' here",
      "const n = m?.[1] || fallback;",
      "ls *.[0-9]*' now",
      "jq '.jobs.[] | .x'",
      "jq '.jobs.[0, 1] | .x'",
      // The guard refuses `*` on its own, not only via the caret form
      // (#2002) or by riding along on the unrelated glob fixture above.
      "**only**.[1] Next",
      // An abbreviation's period is no terminator, marker or not.
      "e.g.[1] Next",
    ]) {
      assert.deepEqual(text.split(new RegExp(SENTENCE_END, flags)), [text], `${text} /${flags}`);
    }
  }
});

// #2063. `][^1]` read two ways under CLOSING_MARKUP — one `][ref]` closer, or
// a bare `]` then a `[^1]` footnote — so a chain of n of them had 2^n
// readings, and SENTENCE_END walked every one before giving up on a chain
// with no whitespace after it. At this n the chain took half a second to
// several seconds, doubling with every link; unambiguous, it takes well under
// a millisecond, so the budget only catches a return to the blow-up, not a
// slow machine.
test("SENTENCE_END stays fast on a closer chain that once read two ways (#2063)", () => {
  const text = "x." + "][^a]".repeat(25) + "z";
  for (const flags of ["", "i"]) {
    const start = performance.now();
    const parts = text.split(new RegExp(SENTENCE_END, flags));
    const ms = performance.now() - start;
    assert.deepEqual(parts, [text], `/${flags}`);
    assert.ok(ms < 100, `${ms.toFixed(0)}ms /${flags}`);
  }
});

// The fix drops only the `][ref]` reading that `]` plus `[^1]` already
// covers, so every closer run ends the same sentences as before. A `][^…]`
// label that `[^1]` cannot read — empty, or holding a space — is still one
// `][ref]` closer; a fix that refused every `][^` would lose those two.
test("SENTENCE_END ends the same sentences behind a `][^…]` closer as before #2063", () => {
  for (const flags of ["", "i"]) {
    const split = (text) => text.split(new RegExp(SENTENCE_END, flags));
    for (const closer of ["][^1]", "][^1]][^2]", "][^a b]", "][^]", "][^vs.]"]) {
      assert.deepEqual(split(`It shipped.${closer} Next`), ["It shipped", "Next"], `${closer} /${flags}`);
      assert.deepEqual(split(`per vs.${closer} next`), [`per vs.${closer} next`], `${closer} /${flags}`);
    }
  }
});

test("both rows read a bare footnote marker as a sentence end (#2027)", () => {
  // The next sentence's scope no longer reaches back across the marker.
  for (const text of [
    "Minor and patch bumps only.[1] Bounding drift at about one month.\n",
    "Minor and patch bumps only.[note] Bounding drift at about one month.\n",
    "Minor and patch bumps only.[^1] Bounding drift at about one month.\n",
  ]) {
    assert.match(text, UNSCOPED_DRIFT_SENTENCE, text);
  }
  // Only the simplest marker (`.[1]`, letter-preceded) reached
  // UNSCOPED_MERGE_SENTENCE below, once — a consumer that quietly stopped
  // splicing the current SENTENCE_END, or carried its own narrower guard,
  // would still pass that single row and only red the direct-split test
  // above. Every marker shape, and a backtick-preceded terminator, through
  // the merge row here too.
  for (const text of [
    "# Minor and patch bumps only.[1] The bump merges once CI goes green.\n",
    "# Minor and patch bumps only.[note] The bump merges once CI goes green.\n",
    "# Minor and patch bumps only.[1][2] The bump merges once CI goes green.\n",
    "# Minor and patch bumps `only`.[1] The bump merges once CI goes green.\n",
  ]) {
    assert.match(text, UNSCOPED_MERGE_SENTENCE, text);
  }
  // The accept side: a scoped sentence quoting a jq index wraps past it.
  assert.doesNotMatch("For minor and patch bumps, jq '.[] | .x' keeps bounding drift at about one month.\n", UNSCOPED_DRIFT_SENTENCE);
  assert.doesNotMatch("For minor and patch bumps, `m?.[1] || x` keeps bounding drift at about one month.\n", UNSCOPED_DRIFT_SENTENCE);
});

// #2431. The `review-pr-*.test.mjs` suite was deleted (ed9f2967) and its
// surviving pins moved to `review-core-*`; the citations that kept naming the old files were
// retargeted by hand. A citation of a file that is gone is only legitimate as a
// git-object path — `<sha>^:plugin/scripts/<name>` or `<sha>:plugin/scripts/<name>`
// — which names the revision it is read at.
const DELETED_TEST_CITATION = /(?<![0-9a-f]{7,40}\^?:\s?plugin\/scripts\/)(?<![\w-])review-pr-[a-z0-9-]+\.test\.mjs/g;
const deletedTestCitations = (text) => [...normalize(text).matchAll(DELETED_TEST_CITATION)].map((m) => m[0]);

function* pluginFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* pluginFiles(full);
    else yield full;
  }
}

test("no file under plugin/ or tests/ cites a deleted review-pr-*.test.mjs without a git-object path (#2431)", () => {
  for (const file of [...pluginFiles(REPO), ...pluginFiles(import.meta.dirname)]) {
    if (file === import.meta.filename) continue;
    assert.deepEqual(deletedTestCitations(readFileSync(file, "utf8")), [], `${file} cites a review-pr-*.test.mjs file that no longer exists — name its review-core-* successor, or a pinned revision such as \`ed9f2967^:plugin/scripts/<name>\``);
  }
});

test("the plugin walk reads extensionless scripts and skips node_modules (#2431)", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-walk-"));
  try {
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "fleet-run"), "// see review-pr-reads.test.mjs\n");
    writeFileSync(join(dir, "sub", "board.html"), "<!-- review-pr-reads.test.mjs -->\n");
    writeFileSync(join(dir, "node_modules", "dep.mjs"), "// review-pr-reads.test.mjs\n");
    assert.deepEqual([...pluginFiles(dir)].map((f) => f.slice(dir.length + 1)).sort(), ["fleet-run", join("sub", "board.html")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the deleted-test citation ban accepts git-object paths and review-core-* names", () => {
  for (const text of [
    "// `ed9f2967^:plugin/scripts/review-pr-inbound-citation-prose.test.mjs` asserted",
    "// f743264:plugin/scripts/review-pr-reads.test.mjs | grep -A2",
    "// in `ed9f2967^:plugin/scripts/review-pr-citation-prose.test.mjs` looked like",
    "// `ed9f2967^:\n// plugin/scripts/review-pr-x.test.mjs` wrapped after the colon",
    "// review-core-snapshot-path.test.mjs's guard-ordering pin.",
    "// prefix-review-pr-x.test.mjs is a different file",
  ]) assert.deepEqual(deletedTestCitations(text), [], text);
  for (const text of [
    "// review-pr-snapshot-path.test.mjs's guard-ordering pin.",
    "// `review-pr-citation-prose.test.mjs`, one",
    "// plugin/scripts/review-pr-reads.test.mjs",
    "// abc^:review-pr-reads.test.mjs",
    "// abc123^:plugin/scripts/review-pr-x.test.mjs",
    "// review-pr-2nd-pass.test.mjs",
  ]) assert.equal(deletedTestCitations(text).length, 1, text);
});
