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
  {
    path: ["..", "docs", "adr", "0007-main-ruleset-is-the-merge-gate.md"],
    stale: [/ci\.yml:\d+/],
    live: ["# Blocking, every PR"],
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
  // `check` job's silently re-points; both now name the `check` job instead,
  // and the positional form is banned. And the evidence counted "8 releases"
  // and a security release "since the pin" without saying from what: 8 is the
  // releases past `26.5.0`, three of them — the security release among them —
  // already out when the pin was set. Those two wordings carry no live
  // needle, for the reason #1756's gives.
  {
    path: ["..", "docs", "adr", "0010-the-node-pin-stays-exact-and-a-bot-moves-it.md"],
    stale: [
      /\blines?\s+\d/,
      /claim-ticket\.test\.mjs:\d/,
      /candidates\.mjs:\d/,
      /board-cli\.test\.mjs:\d/,
      /release\.yml:\d/,
      /release-label\.yml:\d/,
      /\bfirst\s+`?setup-node\b/,
      /across\s+8\s+releases/,
      /landed\s+in\s+26\.x\s+since\s+the\s+pin\b/,
      // A backticked `.mjs` list straight after "used by" that includes either
      // comment-only file, wherever in the list and however it wraps.
      /used by(?:[\s,]*(?:and\s+)?`[\w-]+\.mjs`)*[\s,]*(?:and\s+)?`(?:arg|staleness)\.mjs`/,
      /2026-09-21/,
      /there is no other(?!\s+Renovate-driven\b)/,
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
  {
    path: ["..", ".github", "scripts", "pin-drift.sh"],
    stale: [/across\s+8\s+releases/],
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
