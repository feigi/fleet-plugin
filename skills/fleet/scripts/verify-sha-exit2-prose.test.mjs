// #558. The "Verify every reported SHA" guard is the ONLY consuming-side rule
// for `verify-sha.sh`, and it named exactly one outcome — "Not reachable →
// flag" — so a controller following it literally had no instruction for exit 2,
// "the question could not be answered". In `sh`, both `cmd || handle` and
// `if cmd; then` treat 1 and 2 alike, so the natural reading files an
// unanswerable probe under "not reachable" by accident rather than by rule.
//
// That accident is fail-safe TODAY only because exit 2 emits no JSON at all: a
// controller cannot read `reachable:true` off it. It is not fail-safe in the
// other direction — an unanswerable probe recorded as a real "not reachable"
// verdict flags a member for a stray commit that was never demonstrated, and
// holds its ticket out of the pool "until the maintainer rules" over a failure
// that a re-run would have cleared.
//
// The pins below are the rules the corrected guard has to carry, each checked
// against `verify-sha.sh` itself before being written down:
//
//   1. the three exit codes are named where the command is named, the inline
//      convention `next-ticket/SKILL.md` already uses for `inflight.sh`;
//   2. exit 1 KEEPS its verdict — the flag, the withheld enqueue and the
//      maintainer's ruling still hang off "not reachable", and exit 2 is not
//      allowed to drift into that gap. This is the pin against the fix
//      overshooting: a guard that teaches "non-zero is unanswerable" destroys
//      the one distinction the script exists to make;
//   3. exit 2 gets its own remedy — read stderr, re-run, escalate on repeat —
//      and exit 1's remedy is not allowed to drift into THAT gap;
//   4. the exit-2 branch is stated as a PROPERTY of the exit code, not as a
//      list of causes. Every `die()` in the script produces the identical
//      caller-visible shape (no stdout, cause on stderr), so a cause list adds
//      nothing a controller can act on differently — and it rots on the next
//      commit that adds or removes one. Test 4 forbids the tally outright.
//
// Rule 4 is why this file pins no number. `verify-sha.sh`'s exit-2 paths have
// already grown twice — the `merge-base --is-ancestor` guard, then #119's three
// JSON-escaping guards — and the issue that asked for this fix was filed
// before the last of those landed: its count was accurate when written, and
// stale by the time this fix was. A number written here would age the same way.
//
// THE CEILING, same as inflight-exit2-prose.test.mjs: these are PRESENCE pins
// over a bounded slice, plus two adjacency pins. Text spliced INSIDE a pinned
// phrase reddens them; a whole new sentence appended after one, carving out an
// exception, does not. A reflow (line wraps, `**bold**` moved) stays green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const RUN_TEAM = read("skills", "fleet", "skills", "run-team", "SKILL.md");
const SCRIPT = read("skills", "fleet", "scripts", "verify-sha.sh");

// Bounded at both ends and small: the guard, not the `## Guards` section. A
// slice wide enough to reach its neighbours is satisfied by their vocabulary.
const guard = () =>
  between(RUN_TEAM, "**Verify every reported SHA.**", "**Never `--delete-branch`", "run-team/SKILL.md");

// The tally is the rot. A written count is false the moment a `die()` is added
// or removed, and this script's set has already changed twice.
//
// Scoped to the COUNTED NOUN, not to a bare number near "exit 2": the annotation
// this same guard carries is `2 unanswerable`, which is the exit code's meaning
// and must stay. Measured — the first spelling of this pin reddened on the
// guard's own correct text, and `reachable`/`unanswerable` remain the two nouns
// that can never go in this list.
//
// `cases?` is here because it was measured missing, not guessed: "three
// unanswerable cases" passed this pin green where the same sentence with
// "failure modes" reddened it. `ways?` was measured and REJECTED — it reds
// "Treat exit 2 the same way in all cases", which is prose, not a tally.
const TALLY =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:\w+[-\s]+){0,2}(?:paths?|causes?|cases?|reasons?|branches|failure\s+modes?)\b/i;

test("the guard names the script's exit codes where it names the command", () => {
  assert.match(guard(), phrase("0 reachable, 1 not reachable, 2 unanswerable"));
});

test("exit 1 keeps the verdict — the flag, the held enqueue and the maintainer's ruling", () => {
  // ADJACENCY, not three presence pins: each clause on its own survives the
  // subject being swapped to exit 2, which is the overshoot this guards.
  // `[Ee]xit 2` excluded from the gap so the two branches cannot merge into
  // one. The character class is load-bearing, not decoration: a drifting
  // sentence that opens on the code capitalises it, which a bare `exit` misses.
  assert.match(
    guard(),
    /[Nn]ot\s+reachable\*{0,2}\s*\(exit\s+1\)\s*→\s*flag(?:(?![Ee]xit\s+2)[\s\S]){0,200}?until\s+the\s+maintainer\s+rules/,
    "the not-reachable branch no longer binds exit 1 to flag/hold/maintainer-rules, or exit 2 has drifted into that gap — an unanswerable probe must never spend a maintainer's ruling",
  );
});

test("exit 2 is not a verdict and carries its own remedy", () => {
  // `\*{0,2}` at each wrap point, not a hard-space literal: bolding a phrase in
  // place leaves the rule true and must not red the pin (measured — the first
  // spelling of the exit-1 pin below reddened on `**Not reachable**`).
  assert.match(guard(), /[Ee]xit\s+2\*{0,2}\s+is\s+not\s+a\s+verdict/);
  // Same adjacency shape, mirrored: exit 1's remedy must not drift into the
  // exit-2 gap either. Re-running a genuine "not reachable" hides a stray
  // commit behind a probe that answers the same way every time.
  assert.match(
    guard(),
    /[Ee]xit\s+2\*{0,2}\s+is\s+not\s+a\s+verdict(?:(?![Ee]xit\s+1)[\s\S]){0,400}?re-run/,
    "the exit-2 branch no longer tells the controller to re-run, or exit 1 has drifted into its gap",
  );
  assert.match(guard(), phrase("never record it as a stray commit"));
});

test("the exit-2 branch is stated as a property of the code, never as a tally of causes", () => {
  // The property that makes one rule cover every cause: the caller cannot tell
  // them apart, so it must key on the code.
  assert.match(guard(), phrase("no JSON on stdout"));
  assert.match(guard(), phrase("the cause on stderr"));
  assert.doesNotMatch(
    guard(),
    TALLY,
    "a count of exit-2 paths has been written into the guard — state the property instead; the next `die()` added to verify-sha.sh falsifies the number",
  );
  // The green case, pinned against the same regex and separately from the
  // guard, so the failure MESSAGE stays honest: a noun list widened until it
  // reaches the annotation reds the assertion above saying a count was written
  // into the guard — a lie about text that is correct and required to be there.
  assert.doesNotMatch(
    "`# 0 reachable, 1 not reachable, 2 unanswerable`",
    TALLY,
    "the tally pin's noun list now reaches the guard's own required annotation — `reachable` and `unanswerable` are what the exit codes MEAN, not a count of causes",
  );
});

test("verify-sha.sh still declares the exit codes the guard quotes", () => {
  // Cross-file coupling, otherwise invisible: the guard's annotation is a copy
  // of the script's contract. If the script's codes change, the doc lies and
  // nothing else says so.
  assert.match(SCRIPT, phrase("Exit 0 reachable, 1 not reachable, 2 the question could not be answered"));
  // Every exit-2 path is the same `die`, which is what lets one rule cover all
  // of them. A second exit-2 spelling would need the guard revisited.
  assert.match(SCRIPT, /^die\(\)\s*\{[^}]*exit 2;?\s*\}/m);
  // Comment lines stripped first: this script is two-thirds prose about its own
  // exit codes, and counting the raw substring reds on a comment that merely
  // MENTIONS exit 2 — with a message sending the reader after a code path that
  // does not exist (measured). `\b` also stops `exit 22` from counting. Whole
  // comment lines only, never a trailing `#`: cutting at one would let a `#`
  // inside a quoted string hide a genuine second exit, and a missed exit
  // defeats the assertion, where a comment it still trips is merely loud.
  //
  // No null guard: the `die()` pin above carries this same `exit 2` literal on a
  // line that is not a comment, so reaching here means a match already exists.
  assert.equal(
    SCRIPT.replace(/^\s*#.*$/gm, "").match(/\bexit 2\b/g).length,
    1,
    "verify-sha.sh grew a second way to exit 2 — the guard's single rule covers every cause only because `die()` is the sole one",
  );
});
