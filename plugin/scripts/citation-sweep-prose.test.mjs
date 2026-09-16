import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
// Both halves here are CITING-side: the stale form must not return, and the
// construct the citation names must still be named. Neither reads the cited
// file, so nothing in this table notices the TARGET losing the construct — the
// direction #870 closes for probe 3's citation, in
// inflight-citation-prose.test.mjs, and leaves open for every entry below.
const REPO = join(import.meta.dirname, "..");
const read = (...segments) => readFileSync(join(REPO, ...segments), "utf8");

// Comments wrap; a construct name can land on either side of the wrap. Strip
// the `//` or `#` gutter and collapse whitespace so a presence check does not
// depend on where the line happened to break.
const normalize = (text) => text.replace(/^[ \t]*(?:\/\/|#) ?/gm, "").replace(/\s+/g, " ");

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
    // other `release-ticket.sh:<digit>`, so the general form costs nothing here.
    path: ["scripts", "reaping-prose.test.mjs"],
    stale: [/release-ticket\.sh:\d/],
    // One needle per SITE — the file header, and the comment inside
    // `test("release-ticket.sh: the comment at the dirty check ...")` — because
    // the finding is that the stale form can return to EITHER of them, and a
    // needle satisfied from one site would not notice the other reverting. A
    // bare `release-ticket.sh` would be vacuous outright: that file names the
    // script in unrelated prose, in a path join and in a test name.
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
];

for (const { path, stale, live } of FILES) {
  const label = path.join("/");
  const source = read(...path);
  const prose = normalize(source);

  for (const pattern of stale) {
    test(`${label} does not regress to the stale citation ${pattern}`, () => {
      assert.doesNotMatch(
        source,
        pattern,
        `a stale line-numbered citation matching ${pattern} is back in ${label} — #516 swept this exact form out because the cited file rots out from under a line number silently`,
      );
    });
  }

  for (const needle of live) {
    test(`${label} still names the construct its citation points to (${needle})`, () => {
      assert.ok(
        prose.includes(needle),
        `${label} no longer mentions "${needle}" anywhere — the construct-named citation #516 introduced here appears to have been deleted outright rather than kept current`,
      );
    });
  }
}
