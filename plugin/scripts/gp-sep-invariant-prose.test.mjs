// #1212. `git_probe`'s separator comment justified `gp_sep` as "a byte no
// porcelain line or ordinary warning contains" — a property of the BYTE, and
// not the property that actually holds. What holds is a property of GIT, and
// only for the commands the helper is currently pointed at. That distinction
// is the whole finding: `git_probe` takes `git "$@"`, nothing in its body
// checks the separator's absence, and a caller pointed at output git does not
// quote the same way gets a truncated `$gp_out` plus a non-numeric `$gp_rc`
// fed to `return`. The review that produced it split 1-1 — one refuter
// measured the corruption reproducible against a stub `git`, the other
// measured it unreachable and failing closed — and the single point both
// agreed on is that the comment asserted a boundary the code does not
// enforce.
//
// Re-measured while writing the comment, git 2.50.1 (Apple Git-155):
//
//   `status --porcelain -uall` and `--porcelain -unormal --ignored`, over a
//   file named `weird<0x02>file` and a chmod-000 directory `dir<0x02>name`:
//   zero raw 0x02 bytes, under core.quotePath true AND false. stdout C-quotes
//   the path (`?? "weird\002file"`); stderr renders the byte as `?`
//   (`warning: could not open directory 'dir?name/'`) — two different rules,
//   both landing outside the separator.
//   The SAME command with `-z`: one raw 0x02, straight through. So do
//   `log --format=%s` and `show <rev>:<path>`. The boundary is one flag away
//   from an existing call site, which is why the comment now names it.
//
// WHY THIS FILE EXISTS AT ALL, given the fix is comment-only. The ticket's own
// thesis is that a comment asserted a boundary nothing enforced. Correcting
// the prose and pinning nothing reproduces that one level up — the corrected
// boundary would again rest on whoever read it last. And no behavioural test
// can see this change: the script's bytes below the `#` lines are identical,
// so `reap.sh` behaves identically and `reap.test.mjs` cannot tell the two
// revisions apart. A prose pin is the only enforcement available here, and
// the only thing in the suite that can see the mode this ticket changed.
//
// NOT pinned, deliberately: the corruption path itself. It is unreachable from
// every existing caller — three `status --porcelain` variants protected by
// git's path-quoting, and a fourth (`for-each-ref`, #1413) protected because
// a refname carrying the byte cannot exist in the first place — and a
// test would have to stub `git` to reach it, pinning a hypothetical rather
// than a behaviour. That is the ticket's own out-of-scope ruling, and the same
// reason the competing `$gp_rc` numeric guard was rejected: every call site is
// shaped `if ! git_probe …; then keep …`, so a garbled exit code cannot come
// back 0 and cannot turn a KEEP into a REAP. Nothing here asserts the helper's
// runtime shape; `reap.test.mjs` owns that.
//
// THE SLICE is the run of `#` lines immediately above the `gp_sep`
// declaration, bounded by CODE at both ends. `quiet-payload-prose.test.mjs`
// takes the same bound at `ci-state.mjs`'s header and its own notes say why,
// both halves measured under #695: in source a blank-line bound runs past the
// end of the comment into live code, so a decoy pasted in the code below took
// a whole suite green — and a phrase anchor sits INSIDE the prose it pins, so
// every edit to that prose reads as a moved anchor and reports the wrong
// fault. A one-line declaration is neither. `anchorAt` carries the
// exactly-once half, so a second copy of that declaration reds here rather
// than binding these pins to whichever copy comes first.
//
// This file names its one source by path and globs nothing, so its own text —
// which quotes the old wording in the first paragraph above — is not in the
// corpus and cannot satisfy or defeat the pins it carries.
//
// THE CEILING. These are PRESENCE pins over a bounded slice, plus one revert
// guard. What they catch is a required statement gutted, or the old
// property-of-the-byte wording restored. What they do NOT catch: a
// differently worded restatement of the false claim, or a sentence appended
// after a correct one to walk it back. They also say nothing about whether the
// measurements in the comment are right — they pin that the comment
// attributes the safety to git rather than to the byte, names the scope it
// holds at, names each call-site group's OWN safety rule rather than one
// rule for all of them, says the code does not check either invariant, and
// warns the next caller off.
//
// Zero deps: `node --test plugin/scripts/gp-sep-invariant-prose.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { phrase, runAbove, stripHashGutter } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const REAP = "scripts/reap.sh";
const SOURCE = readFileSync(join(REPO, ...REAP.split("/")), "utf8");

// The declaration the comment documents, and the slice's lower bound.
const ANCHOR = "gp_sep=$(printf '\\002')";

// The `#` run immediately above the anchor, gutter stripped and flattened to a
// single line: a wrapped comment breaks a sentence at the `# ` gutter, which
// `phrase()`'s `\s+` does not span.
//
// The shared bound, not a local copy of it (#1604). `runAbove` owns the slice —
// the exactly-once anchor through `anchorAt`, and the run matched only where a
// `#` is a line's first token, so the bound is code at both ends rather than a
// blank line that would run past the comment into the script. Only the gutter
// strip is this file's: the `//` consumers of the same bound compare raw bytes
// and must not have it.
const separatorComment = (text) => stripHashGutter(runAbove(text, ANCHOR, REAP, "#"));

const COMMENT = separatorComment(SOURCE);

// Each row is one thing the comment has to say, and the acceptance criterion it
// answers. Kept as a table rather than inline so the rewrap check at the foot
// runs the same regexes rather than a second copy of them that could drift.
const PINS = [
  [
    "attributes the safety to git's quoting, not to the byte",
    "git C-quotes the path",
    "the separator is safe because of what GIT does to a control byte in a path, which is the claim that actually holds",
  ],
  [
    "says the code does not check either invariant",
    "Nothing in the body checks either invariant",
    "the one point both refuters agreed on: the invariant is asserted here and enforced nowhere",
  ],
  [
    "names the scope the invariant holds at",
    "safe only for the commands this helper is currently pointed at",
    "an invariant with no stated scope is one a future caller inherits without knowing it exists",
  ],
  [
    "names the porcelain-reading call sites by an exact count, not by \"every\"",
    "Three call sites below read `status --porcelain`",
    "\"every call site\" was the false claim (#1601 review): a fourth call site, `for-each-ref`, was added by #1413 and does not read `status --porcelain` at all — the boundary has to name an exact, checkable count",
  ],
  [
    "names the for-each-ref call site's different safety rule",
    "a REFNAME, unlike a path, can never contain the byte at all",
    "the fourth call site is safe for a reason that has nothing to do with git quoting a path — collapsing the two mechanisms into one claim is exactly how #1601's false \"every call site\" wording happened",
  ],
  [
    "warns the next caller off output carrying neither guarantee",
    "DO NOT POINT `git_probe` AT A COMMAND WHOSE OUTPUT CARRIES NEITHER GUARANTEE",
    "`git_probe` takes `git \"$@\"`, so the invariant is the caller's to keep and this warning is the only thing that tells them so",
  ],
  [
    "keeps the `set -e` rationale it sits above",
    "under `set -e` a bare failing assignment aborts the subshell",
    "a separate, still-accurate finding (PR #1068) that shares this comment block and must survive edits to the separator paragraph",
  ],
  [
    "keeps the bare-assignment note that rationale is about",
    "never a bare `gp_o=$(...); gp_rc=$?`",
    "the shape the `set -e` finding is about — the rationale without it names no construct",
  ],
];

// The guard on the guard. Every positive pin below reds on an empty slice, so
// those are self-diagnosing; the revert guard is a `doesNotMatch` and would
// pass vacuously over one. A moved or duplicated anchor already throws inside
// `anchorAt` — this covers the remaining way the slice comes back empty, the
// declaration losing the comment run above it altogether.
test("the comment run above the gp_sep declaration is found at all", () => {
  assert.ok(
    COMMENT.trim().length > 0,
    `${REAP}: no \`#\` run sits immediately above \`${ANCHOR}\`, so the slice these pins assert over is empty and they prove nothing. Re-derive the bound — never widen it to the whole file.`,
  );
});

for (const [what, text, why] of PINS) {
  test(`the git_probe separator comment ${what}`, () => {
    assert.match(
      COMMENT,
      phrase(text),
      `${REAP}: the comment above \`${ANCHOR}\` no longer says "${text}". ${why} (#1212)`,
    );
  });
}

// The revert guard, and the half AC 1 states negatively: the comment must no
// longer describe 0x02 as a byte git's output cannot contain, in any casing.
// Measured false — `status --porcelain -uall -z` emits it, and so does any
// command printing content rather than paths — and it is the wrong shape of
// claim regardless, since it reads as a property of the byte that needs no
// scope. Matched case-insensitively, unlike every positive pin above: those
// are satisfied by phrase() finding the words ANYWHERE, so casing never hides
// a false negative, but this is the one `doesNotMatch` in the file, and a
// caller who reintroduces this exact retired clause as a sentence's opening —
// this file's own prose style, see "WHY THIS FILE EXISTS", "THE SLICE",
// "THE CEILING" above — capitalizes its first letter for free, which a
// case-sensitive doesNotMatch would silently let back in.
test("the git_probe separator comment no longer claims 0x02 is absent from porcelain output", () => {
  assert.doesNotMatch(
    COMMENT,
    new RegExp(phrase("a byte no porcelain line or ordinary warning contains").source, "i"),
    `${REAP}: the comment above \`${ANCHOR}\` is back to describing \`gp_sep\` as a byte git's output cannot contain. That states a property of the BYTE and carries no scope, so a caller pointed at `
      + "`status --porcelain -uall -z` (which does emit the raw byte, measured) inherits an assumption nothing checks. State what git does to a control byte in a path, and where that stops holding. (#1212)",
  );
});
