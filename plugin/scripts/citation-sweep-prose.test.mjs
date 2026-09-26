import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
// inflight-citation-prose.test.mjs, and leaves open for every entry below.
//
// One target-side check runs here, for one citation shape only (#1757): a
// `live` needle that names an ADR by number (`ADR 0010`) is a pointer, and the
// number must still resolve to exactly one `docs/adr/<number>-*.md`. Read off
// the needle itself, never a second list, so the pointer and what it is checked
// against have one spelling between them — the reason inflight-citation-prose's
// WTROOT gives: renumber or move the ADR and this reds; repoint the needle
// alone and the needle reds against the citing file's unchanged prose. The
// pointer names the ADR by number, so a retitle that keeps the number keeps
// the pointer true and stays green. A construct needle is still never checked
// against its target.
//
// And one claim is held by what it says, not by how it was spelled (#1928):
// ADR 0010's security release, which a stale form here once guarded by the
// wrong sentence's exact words. A false claim needs no particular spelling to
// return, so securityReleaseFault reads which side of the pin the ADR places
// v26.5.1 on. It is the table's stale-form rule taken one step further, for a
// claim whose rewording is as likely as its reversion — not a second
// convention to reach for when a spelling ban would do.
const REPO = join(import.meta.dirname, "..");
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

// #1928. ADR 0010's security evidence names its one security release past
// `26.5.0`, v26.5.1, and #1874 corrected WHEN it landed: already out when #335
// set the pin, not "since the pin". The spelling ban this replaced refused
// only that sentence; "v26.5.1, which has since landed after the pin was set"
// states the same false claim and passed every test here. So the claim is read
// for what it says. Null when the evidence still says v26.5.1 predates the
// pin, else the reason. Takes the text rather than reading the ADR itself, so
// the tests below can hand it rewordings the ADR does not hold.
//
// The scope is each markdown block — list item or paragraph — naming
// "security", never the document: the release-list bullet above it says
// v26.5.1 was "already out when the pin was set" as well, and read file-wide
// that sentence vouches for a security bullet claiming the opposite. Inside
// the scope, each clause (cut at `, ; : ( ) — –` and sentence ends) is read
// for what it places relative to the pin: the order word nearest before a
// `pin…` mention decides — "already", "before", "predates", "prior to",
// "earlier than", "ahead of" put the release before it; "since", "after",
// "postdates", "later than" after it — and "in", "within", "inside" or
// "during" the N days (or the window) places it after the pin too. A negation
// in the same breath as that word flips the side, scanned back only to the
// nearest `and`/`but`/`so`/`yet` or the clause start — so a `not` attached to
// an earlier, unrelated verb ("does not affect us and landed after…") can't
// reach across it, and `not…until` reads as naming the word after `until`,
// not negating it ("didn't land until after" stays after). "none landed in
// the 43 days after" is a before-the-pin claim; nearest, not first, is what
// lets "since" be a conjunction — "since it predates the pin" is read at
// "predates". Any after-the-pin clause reds, even beside a before-the-pin
// one, and a scope with no before-the-pin clause reds.
//
// THE CEILING. It knows those words and nothing else. A true reword outside
// them — "out by the time #335 pinned it", or the pin as the subject, "the pin
// came after v26.5.1" — reds, the loud direction; a false claim outside them
// passes only if the scope also keeps a clause that still reads before the
// pin. It reads no date, so it holds the ADR to #1874's measurement, and it
// cannot notice a double negation. Every block naming "security" is in scope,
// so a later amendment that names it and places any release after the pin
// reds too — a claim of the same shape, and worth the same re-read.
const PIN_ORDER = new RegExp(
  [
    String.raw`\b(?<before>already|before|predat\w*|prior\s+to|earlier\s+than|ahead\s+of)\b`,
    String.raw`\b(?<after>since|after|postdat\w*|later\s+than)\b`,
    String.raw`\b(?<window>(?:in|within|inside|during)\s+(?:the|those|that|this|its)\s+(?:\d+[\s-]days?|(?:\d+[\s-]day\s+)?window))\b`,
    // Only "pin", "pins", "pinned" or "pinning" — not every pin-prefixed
    // word. A bare `pin\w*` also matched "pinpointed", letting an unrelated
    // before-clause about "the pinpointed advisory" stand in for the pin.
    String.raw`\b(?<pin>pin(?:s|ned|ning)?)\b`,
  ].join("|"),
  "gi",
);
// Bounds the negation scan below to the same breath as the order word: text
// back to the nearest coordinating conjunction, not the whole clause.
const CLAUSE_BREAK = /\b(?:and|but|so|yet)\b/gi;
const NEGATION = /\b(?:not|no|none|never|nothing|neither|nor|cannot)\b|n['’]t\b/i;
const OTHER_SIDE = { before: "after", after: "before" };

function securityReleaseFault(adr) {
  const scope = adr
    .split(/\n(?=[ \t]*(?:[-*+]|\d+\.)[ \t])|\n[ \t]*\n/)
    .map((block) => block.replace(/\s+/g, " "))
    .filter((block) => /\bsecurity\b/i.test(block));
  if (scope.length === 0) {
    return "ADR 0010 no longer names a security release in its evidence — the claim #1874 corrected, that v26.5.1 predates the pin, is gone rather than kept current";
  }
  if (!scope.some((block) => /\bv?26\.5\.1\b/.test(block))) {
    return "ADR 0010's security-release evidence no longer names v26.5.1, the one security release past `26.5.0` (#1874)";
  }
  let before = false;
  for (const clause of scope.flatMap((block) => block.split(/[,;:()—–]|[.!?]\**\s/))) {
    let side = null;
    let last = 0;
    for (const { groups, index, 0: token } of clause.matchAll(PIN_ORDER)) {
      let window = clause.slice(last, index);
      const breaks = [...window.matchAll(CLAUSE_BREAK)];
      if (breaks.length) window = window.slice(breaks[breaks.length - 1].index + breaks[breaks.length - 1][0].length);
      const negated = NEGATION.test(window) && !/\buntil\b/i.test(window);
      last = index + token.length;
      if (groups.before || groups.after) {
        const said = groups.before ? "before" : "after";
        side = negated ? OTHER_SIDE[said] : said;
        continue;
      }
      // A pin mention takes the side of the order word nearest before it; a
      // window is the 43 days after the pin, so landing in it is "after".
      const placed = groups.pin ? side : negated ? "before" : "after";
      side = null;
      if (placed === "after") {
        return `ADR 0010's security-release evidence places it after the pin ("${clause.trim()}") — v26.5.1 was already out when #335 set the pin, so none landed in the 43 days after (#1874, #1928)`;
      }
      if (placed === "before") before = true;
    }
  }
  return before
    ? null
    : "ADR 0010's security-release evidence no longer says v26.5.1 predates the pin — state it in that bullet's own words: already out when, before, predates, prior to, earlier than or ahead of the pin (#1874, #1928)";
}

// #1957. Where a sentence ends, for ADR 0010's drift-sentence row below: at
// `.`, `!` or `?`, after any closing markup — `**`, `_`, a backtick, `)`, `]`,
// a quote — then whitespace; or where a markdown block ends, as
// securityReleaseFault splits them: a blank line, or the newline before a
// `-`/`*`/`+` list item (an ordered item's `3. ` is already a terminator and
// whitespace). The row's first cut, a bare `\.\s`, missed point 3's bold
// heading ending `bumps.**`, so the heading's "minor and patch" read as the
// next sentence's own scope, and an unscoped drift claim under a scoped
// heading passed. A lone newline is no end: prose wraps mid-sentence. So a
// heading with no terminator and no blank line after it still lends the next
// line its scope — telling that line end from a wrap takes parsing the
// heading, which a sentence boundary cannot do.
const SENTENCE_END = String.raw`(?:[.!?][*_\x60)\]"'”’]*\s|\n(?=[ \t]*[-*+][ \t])|\n[ \t]*\n)`;
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
const UNSCOPED_MERGE_SENTENCE = new RegExp(
  String.raw`(?:^|${SENTENCE_END})(?=(?:(?!${SENTENCE_END})[^])*?\b(?:auto-?)?merg(?:e[sd]?|ing)\b)(?=(?:(?!${SENTENCE_END})[^])*?\b(?:checks?|CI|green)\b)(?:(?!${SENTENCE_END}|${UPDATE_TYPE})[^])*(?:${SENTENCE_END}|$)`,
  "i",
);

const FILES = [
  {
    path: ["scripts", "arg.test.mjs"],
    stale: [/ledger\.mjs:441/, /board\.mjs:76-79/],
    live: ["tryRun"],
  },
  {
    path: ["scripts", "candidates-exit3-prose.test.mjs"],
    stale: [/candidates\.mjs:378/, /\(:390\)/, /\(:424\)/],
    live: ["allFilteredOut", "process.exitCode"],
  },
  {
    path: ["scripts", "candidates.test.mjs"],
    stale: [/next-ticket\/SKILL\.md:15/],
    live: ["## 1. Candidates"],
  },
  {
    // #1935. Two citations of `run-merge-bot.md:195` in this file, both
    // pointing at the CLAUDE-harness CI wait's shell-timeout-vs-CI-cycle
    // claim, and both already stale before #1895's step-1 fire/poll split
    // moved the target's own numbering again. Banned generally rather than
    // at the one drifted value: a ban on `:195` alone lets `:196` or any
    // other number straight back in, and this file already carried the
    // identical stale number at two independent sites.
    path: ["scripts", "fleet-heartbeat.mjs"],
    stale: [/run-merge-bot\.md:\d+/],
    // One needle per SITE — either can revert independently of the other.
    live: [
      "run-merge-bot.md's CLAUDE-harness CI wait already records",
      "run-merge-bot.md's CLAUDE-harness CI wait measures",
    ],
  },
  {
    path: ["scripts", "implementer-model-tier.test.mjs"],
    stale: [/member-lifecycle\.md:7/],
    live: ["member-lifecycle.md's"],
  },
  {
    path: ["scripts", "ledger.mjs"],
    stale: [/fleet-plugin-design\.md:200/, /candidates\.mjs:279/],
    live: ["fleet-plugin-design.md's", "refuseIfCapped"],
  },
  {
    path: ["scripts", "ledger.test.mjs"],
    stale: [/fleet-plugin-design\.md:200/],
    live: ["fleet-plugin-design.md's"],
  },
  {
    path: ["scripts", "lift.mjs"],
    stale: [/review-pr-specialist-read-rules-design\.md:277/],
    live: ["review-pr-specialist-read-rules-design.md"],
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
    path: ["scripts", "printf-die-sweep.test.mjs"],
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
    path: ["scripts", "reaping-prose.test.mjs"],
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
    path: ["scripts", "release-ticket.test.mjs"],
    stale: [/release-ticket\.sh:303/],
    live: ["empty-entry skip"],
  },
  {
    // #1935. `run-merge-bot.md:161` sat in a list of four `git -C` idiom
    // citations and was already stale before #1895's step-1 fire/poll split
    // moved the target's own numbering again — the cited line was a STOP
    // arm, not the `git -C <worktree> rev-parse HEAD` example this citation
    // names. Banned generally, the same reason the fleet-heartbeat.mjs entry
    // above gives. The other three citations sharing this list
    // (derive-testcmd.sh, SKILL.md, member-lifecycle.md) are untouched here
    // — out of scope for this ticket, not re-derived either way.
    path: ["scripts", "review-pr-citation-prose.test.mjs"],
    stale: [/run-merge-bot\.md:\d+/],
    live: [`run-merge-bot.md's "Confirm the worktree head *is* the reviewed remote PR head before rebasing" step`],
  },
  {
    path: ["scripts", "review-pr-reads.test.mjs"],
    stale: [/select-dimensions\.test\.mjs:23-40/, /select-dimensions\.test\.mjs:211-216/],
    live: ["liftFromSource", "reviewDispatchOptions"],
  },
  {
    path: ["scripts", "review-pr-snapshot-path.test.mjs"],
    stale: [/select-dimensions\.test\.mjs:251-256/, /review-pr-citation-prose\.test\.mjs:23/],
    live: ["resolveDimensions", "review-pr-citation-prose.test.mjs"],
  },
  {
    path: ["scripts", "run-merge-bot-prose.test.mjs"],
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
  {
    // #1555. The one entry here that is not a citation. #1125 moved this
    // file's `resolveDimensions` lift onto stripComments(SOURCE) because
    // lift() matches with a non-global `.match`, so against raw source a
    // block-commented dead copy of the function satisfies the pin while the
    // live declaration ships the regression. Reverting that one line alone
    // was measured green everywhere — this suite and select-dimensions.test.mjs
    // both — so nothing but this entry stops it rotting back.
    path: ["scripts", "select-dimensions.test.mjs"],
    // Banned generally rather than at the one reverted spelling, the reason
    // the run-merge-bot entry above gives: a ban on `lift(SOURCE,` alone lets
    // `lift( SOURCE` straight back in. That claim is about the TARGET file:
    // select-dimensions.test.mjs spells `lift(` on nothing starting SOURCE
    // today. It is not a claim about this file — this comment block's own
    // prose, describing the banned pattern, does spell it literally (as text
    // above and in this sentence), which is fine and expected: `stale` below
    // matches select-dimensions.test.mjs's source, never this file's.
    stale: [/lift\(\s*SOURCE/, /const CODE = SOURCE\b/],
    // The whole live call, not a bare `stripComments(SOURCE)`: that shorter
    // needle is vacuous here. Deleting this lift outright still leaves five
    // spellings of it in that file — the `verifiersFor` branch's stripped
    // read, the header-dereference check, the specialistModel ban, and two
    // comments, which count because the live half matches gutter-stripped
    // prose. Measured both ways with the lift's line deleted: the needle
    // below reds, a bare `stripComments(SOURCE)` stays green.
    //
    // Second pair: `verifiersFor`'s own stripped read (line 72), the repo's
    // only guard on the live `verifiersBySeverity` map per that branch's own
    // comment. Reverting just that one line to `const CODE = SOURCE;` was
    // measured green across this suite AND select-dimensions.test.mjs's own
    // 41 tests — the same silent-rot shape as the `resolveDimensions` pair
    // above, so it gets the same two-sided pin.
    live: ['lift(stripComments(SOURCE), "resolveDimensions"', "const CODE = stripComments(SOURCE);"],
  },
  // #1349 retired this entry outright rather than leaving it to rot: the
  // vendored `code-reviewer.md` this citation pointed at (via its "Review
  // Scope" section) no longer exists anywhere in this port — the fork ruled
  // on #1303 drops the whole `pr-review-toolkit` dependency, so there is no
  // construct left to name here. Removed with the ticket that obsoleted it,
  // not left as a stale form for a future sweep to catch.
  {
    path: ["skills", "run-team", "SKILL.md"],
    stale: [/board\.mjs:153/],
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
  {
    path: ["..", "docs", "adr", "0007-main-ruleset-is-the-merge-gate.md"],
    stale: [/ci\.yml:\d+/, /release\.yml:\d+/, /release-label\.yml:\d+/],
    live: [
      "# Blocking, every PR",
      "`release.yml`'s `Determine bump segment` step",
      "`release-label.yml`'s `auto-label-bots` job",
      "`release-label.yml`'s `validate-release-label` job",
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
  // release among them — already out when the pin was set. The count's
  // wording carries no live needle, for the reason #1756's gives. The
  // security release's was a ban on the old sentence's spelling until #1928:
  // the same false claim in other words passed it, so securityReleaseFault,
  // above the table, reads that claim for what it says instead.
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
  // the claim only in the NEXT sentence reds too. No live needle, for the
  // reason #1756's gives.
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
      /across\s+8\s+releases/,
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
  // days. The count is corrected in both files; this keeps the copy from
  // reverting on its own.
  //
  // #1925. The bound's argument in pin-drift.sh, and the cadence note in
  // pin-drift.yml that leans on it, still described the Renovate schedule
  // #1753 replaced: the 1st of each month, 00:00–04:59 UTC. The window is now
  // all day on the 1st–3rd, so the longest healthy gap is no longer "up to 31
  // days", 35 leaves about a day of slack rather than "a few days'", and a
  // Monday run on the 1st–3rd falls inside the window rather than "never"
  // racing it. Each stale wording is banned in the file that carried it, and
  // `(?:\s|#)+` spans a wrap across the `# ` gutter as the #1874 ban does. No
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
    path: ["..", ".github", "scripts", "pin-drift.sh"],
    stale: [
      /across(?:\s|#)+8(?:\s|#)+releases/,
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
  // after the other lost its pointer. These are new pointers, not converted
  // ones, so the entry carries no `stale` form.
  {
    path: ["..", "CONTEXT.md"],
    stale: [],
    live: ["**Consumer floor** (ADR 0010)", "**Runtime pin** (ADR 0010)"],
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

test("an ADR pointer resolves by number alone, so a retitled ADR still answers to it", () => {
  assert.equal(adrFault("0010", ["0009-supported-platforms-are-macos-linux-wsl.md", "0010-a-retitled-ruling.md"]), null);
});

test("an ADR pointer reds once its number stops naming exactly one file: renumbered, moved out, or doubled", () => {
  assert.match(adrFault("0010", ["0009-supported-platforms-are-macos-linux-wsl.md", "0014-the-node-pin-stays-exact-and-a-bot-moves-it.md"]), /no docs\/adr\/0010-\*\.md/);
  assert.match(adrFault("0010", []), /no docs\/adr\/0010-\*\.md/);
  assert.match(adrFault("0010", ["0010-one-ruling.md", "0010-another-ruling.md"]), /2 files answer to ADR 0010/);
});

// #1928. The security bullet in a fixture ADR, between two neighbours that
// stay fixed: the release-list bullet above names v26.5.1 as "already out when
// the pin was set" too, so a claim the security bullet no longer makes has a
// true one right beside it to lean on — the scope the fault reads is what the
// last of these tests proves.
const adrWith = (claim) =>
  [
    "- **The exact pin does not get bumped.** Three more past `26.5.0` — v26.5.1, v26.6.0",
    "  and v26.7.0 — were already out when the pin was set.",
    "- **Security was never the axis.** Of those 8 releases past `26.5.0`, exactly",
    `  one was a security release — ${claim} — and node here runs \`node --check\` on`,
    "  tracked files and this repo's own suite: no server, no untrusted input, no",
    "  published artifact.",
    "- **Reproducibility is the real axis.** This suite pins node's *own* behaviour.",
  ].join("\n");

test("ADR 0010's security evidence still says its lone security release predates the pin (#1928)", () => {
  assert.equal(securityReleaseFault(read(...ADR_0010)), null);
});

test("a security-release claim reworded with v26.5.1 still before the pin is accepted (#1928)", () => {
  for (const claim of [
    "v26.5.1, already out when the pin was set, so none landed in the 43 days after",
    "v26.5.1, which predates the pin",
    "v26.5.1, shipped before #335 set the pin, and none has landed since",
    "v26.5.1, and none has landed since the pin",
    "v26.5.1, which did not land after the pin was set",
    // "since" as the causal conjunction: the order word nearest the pin is
    // "predates", so a first-word reading refuses the first of these. In the
    // second, the "cannot" before "since" negates nothing about "predates".
    "v26.5.1, which is harmless here since it predates the pin",
    "v26.5.1, which cannot matter here since it predates the pin",
  ]) {
    assert.equal(securityReleaseFault(adrWith(claim)), null, claim);
  }
});

test("the same false claim in other words — v26.5.1 landing after the pin — is refused (#1928)", () => {
  for (const claim of [
    // The rewording #1928 was filed on, which the spelling ban let through.
    "v26.5.1, which has since landed after the pin was set",
    "v26.5.1, which postdates the pin",
    "v26.5.1, which landed in the 43 days after #335 pinned it",
    "v26.5.1, which landed during the 43-day window",
    "v26.5.1, which was not already out when the pin was set",
  ]) {
    assert.match(securityReleaseFault(adrWith(claim)), /places it after the pin/, claim);
  }
});

test("a negation on an earlier, unrelated verb does not excuse an after-the-pin clause in the same breath (PR #1969 review)", () => {
  // Caught in #1969's review: `NEGATION.test(clause.slice(last, index))` used
  // to scan the WHOLE span back to the previous match, so a `not` attached to
  // a different verb, on the other side of `and`, wrongly flipped "after" to
  // "before" — accepting the exact false claim #1928 exists to refuse.
  for (const claim of [
    "v26.5.1, which does not affect us and landed after the pin was set",
    "v26.5.1, which is not exploitable here and landed after the pin",
  ]) {
    assert.match(securityReleaseFault(adrWith(claim)), /places it after the pin/, claim);
  }
});

test("`not … until` names the word after `until`, it does not negate it (PR #1969 review)", () => {
  // "didn't land until after the pin" states the pin as when it DID land —
  // the most natural English phrasing of the false claim, and the negation
  // scan used to flip it to a before-the-pin claim regardless.
  for (const claim of ["v26.5.1, which didn't land until after the pin was set", "v26.5.1, which wasn't out until after the pin"]) {
    assert.match(securityReleaseFault(adrWith(claim)), /places it after the pin/, claim);
  }
});

test("the pin token only matches \"pin\", \"pins\", \"pinned\" or \"pinning\" (PR #1969 review)", () => {
  // A bare `pin\w*` also matched "pinpointed", so an unrelated before-clause
  // about "the pinpointed advisory" stood in for the pin mention itself,
  // leaving `before` true and excusing a same-clause "landed after #335" — a
  // false claim in the function's own vocabulary — as accepted. Tightened,
  // neither clause names the pin at all (the second names it only as
  // "#335", outside vocabulary — the loud direction, per THE CEILING), so
  // the claim is refused for naming no valid before-clause rather than
  // silently accepted.
  assert.match(
    securityReleaseFault(adrWith("v26.5.1, which predates the pinpointed advisory, landed after #335")),
    /no longer says v26\.5\.1 predates the pin/,
  );
});

test("the sentence #1874 replaced is refused for what it says, not how it was spelled (#1928)", () => {
  const before1874 = [
    "- **Security was never the axis.** Exactly one security release (v26.5.1) landed",
    "  in 26.x since the pin, and node here runs `node --check` on tracked files and",
    "  this repo's own suite: no server, no untrusted input, no published artifact.",
  ].join("\n");
  assert.match(securityReleaseFault(before1874), /places it after the pin \("landed in 26\.x since the pin"\)/);
});

test("a before-the-pin clause does not excuse an after-the-pin one beside it (#1928)", () => {
  // The negative half's own case: the positive half alone passes this.
  assert.match(
    securityReleaseFault(adrWith("v26.5.1, already out when the pin was set; it has since landed after the pin")),
    /places it after the pin \("it has since landed after the pin"\)/,
  );
});

test("the security bullet must place v26.5.1 before the pin itself — no neighbour vouches for it (#1928)", () => {
  for (const claim of ["v26.5.1, which is outside this repo's threat model", "v26.5.1, not yet out when the pin was set"]) {
    assert.match(securityReleaseFault(adrWith(claim)), /no longer says v26\.5\.1 predates the pin/, claim);
  }
  assert.match(securityReleaseFault(adrWith("v26.8.0, already out when the pin was set")), /no longer names v26\.5\.1/);
  assert.match(securityReleaseFault(adrWith("v26.5.1").split("\n").slice(0, 2).join("\n")), /no longer names a security release/);
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
  ]) {
    assert.doesNotMatch(text, UNSCOPED_AUTOMERGED_SPAN, text);
  }
  for (const text of [
    "For _patch_ bumps, bounding drift at about one month.\n",
    "Bounding drift at about one month for minors and patches.\n",
    "Majors aside, bounding drift at about one month.\n",
  ]) {
    assert.doesNotMatch(text, UNSCOPED_DRIFT_SENTENCE, text);
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
