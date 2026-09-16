import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, stripHashGutter } from "./prose-pin.mjs";

// #800. Probe 3's comment borrows its rule from release-ticket.sh's
// worktree-registry read and cited that check by LINE. The line it named had
// stopped being that check — it landed in the argument-validation prose
// instead — and no test read inflight.sh as text, so a green run said nothing
// about it. The mismatch surfaced only when a review audited every
// line-numbered reference into release-ticket.sh in the tree, which is the one
// place a citation this shape can be checked at all.
//
// The convention that closes it is release-ticket.test.mjs's own: "The sites
// are named by construct throughout, never by line: they have moved every time
// this file was touched." So the citing-side pins below are a pair — the
// construct has to be named, and the form that rotted must not come back.
// Neither alone holds: the positive pin stays green beside a stray line
// citation, and the negative pin stays green if the whole clause is deleted.
//
// The negative pin forbids a citation FORM, not a vocabulary: a bare
// `release-ticket.sh` is exactly what the positive pin requires, so the
// accepting case is pinned here too rather than assumed.
//
// #870 adds the third pin, and it is the only one on the TARGET side. A
// construct citation rots less often than a line citation, not never: a pure
// identifier rename in release-ticket.sh — `s/\bwtroot\b/wt_registry/g`, zero
// behaviour change, no output or exit difference — left both pins above green
// while this file's prose named a `$wtroot` that release-ticket.sh no longer
// had. Measured on a copy of the tree before this pin existed: the whole
// `scripts/*.test.mjs` suite identical to the unmutated baseline.
//
// What the rename costs a reader is MISDIRECTION, not a dangling pointer.
// inflight.sh carries an identically-shaped guard on its own `$wtroot`, in its
// own `count_registry`, so a reader who greps the cited words after the rename
// lands on the CITING file's copy and reads it as the thing cited. The
// pre-#800 line citation pointed at unrelated prose, which a reader notices;
// this one would point at a real guard of the right shape in the wrong file,
// which a reader does not.
//
// Not a second existence check. release-ticket.test.mjs's `test("an unreadable
// worktree registry is unknown, never a release")` exercises modes `0o000` and
// `0o400`, and so already pins the guard's EXISTENCE and its `&&` — measured
// there: deleting the guard reds it, and weakening the `&&` to an `||` reds it
// too, because read-without-execute satisfies one half. What no behavioural
// test can pin is the guard's SPELLING, and the spelling is the whole of what
// a citation hands a reader. Coupling the prose to the identifier is the gap;
// re-checking that the guard exists would not touch it.
//
// The identifier has exactly one literal spelling in this file: WTROOT,
// defined below, right after the two file reads it sits beside. Both the
// citing-side phrase above and the target-side phrase below interpolate it
// rather than each spelling the word out, so the two pins cannot
// independently drift the way #870's own reproduction showed they could:
// rename release-ticket.sh's identifier, then patch only the target-side
// literal to match, and the suite used to go green while probe 3's comment
// still named the old one. Renaming WTROOT moves both phrases together, so
// that edit alone reds the citing-side pin against inflight.sh's untouched
// prose; editing release-ticket.sh alone without touching WTROOT reds the
// target-side pin as before. There is no single edit that turns the suite
// green without also fixing the citation.
//
// It lives HERE, with the citation, not in release-ticket.test.mjs. That file
// owns claims about release-ticket.sh's behaviour; this is a claim about what
// probe 3's comment promises, and a lone spelling literal parked beside a
// behavioural suite reads as unexplained with its reason in another file. The
// cost is that this file no longer reads inflight.sh alone — stated here
// rather than left for a reader to discover at the second `readFileSync`.
//
// THE CEILING, same as reaping-prose.test.mjs: PRESENCE pins over a bounded
// slice. Text spliced INSIDE the pinned clause reddens them; a whole new
// sentence appended after one, carving out an exception, does not. Reflow stays
// green by design — the words are pinned, not their layout — and that now holds
// on BOTH sides: the target-side pin goes through `phrase()` too, so re-wrapping
// the guard across lines keeps it green and only a changed token reds it.
//
// Two residuals the target-side slice narrows without closing. A whole-line `#`
// comment INSIDE `count_registry` that restates the guard verbatim would satisfy
// the pin with the code renamed: the slice is not comment-stripped, and
// release-ticket.sh does restate this guard in prose — its recount comment says
// "`count_registry`'s own `[ -r ] && [ -x ]` guard on $wtroot" — which is why
// the slice is bounded at all, and that restatement sits outside it. And a
// reflow that breaks the guard on a line-continuation `\` reds falsely, because
// `\s+` does not span a backslash; the failure names both sites and is cleared
// by touching either, which is the direction to be wrong in.
const INFLIGHT = readFileSync(join(import.meta.dirname, "inflight.sh"), "utf8");
const RELEASE_TICKET = readFileSync(join(import.meta.dirname, "release-ticket.sh"), "utf8");

// The one literal spelling of the identifier the guard below protects,
// named once so the citing-side and target-side phrases below cannot go out
// of sync with each other — see the note above the citing-side pin.
const WTROOT = "$wtroot";

// Bounded at both ends, by the probe's own heading and by the function the
// comment documents. inflight.sh names release-ticket.sh in other comments, on
// both sides of this slice; none of them satisfies the positive pin or trips
// the negative one today, and the bounds are what keep a future one from doing
// either with probe 3's clause untouched.
const probe3 = () =>
  stripHashGutter(
    between(INFLIGHT, "# Probe 3 — a local worktree or branch.", "probe_local() {", "inflight.sh"),
  );

test("probe 3 names release-ticket.sh's worktree-registry guard by construct (#800)", () => {
  assert.match(
    probe3(),
    phrase(`release-ticket.sh's \`-r\`/\`-x\` guard on \`${WTROOT}\``),
    "probe 3 no longer names the check it borrows the establish-absence rule from, so a reader has nothing to follow to it",
  );
});

test("probe 3 cites release-ticket.sh by construct, never by line (#800)", () => {
  assert.doesNotMatch(
    probe3(),
    /release-ticket\.sh:\d/,
    "a line-numbered citation into release-ticket.sh is back in probe 3's comment — the next insertion in that file moves the content out from under the number, which is how the previous one came to name the argument-validation prose instead of the registry check",
  );
});

// The target side, bounded by `count_registry`'s own opening and by the entry
// loop's `-d` skip below the guard. Both bounds are CODE, deliberately: this
// pin's subject is code, and bounding it on a neighbouring COMMENT would make
// another file's prose load-bearing for this assertion — the rot this file is
// about, one level out. Both survive the rename the pin exists to catch, so a
// rename reds on the assertion, with its own message, rather than on
// `between`'s update-this-test throw. The slice is read RAW, never through
// `stripHashGutter`: the `#` gutter is what stops a WRAPPED comment restating
// the guard from satisfying a `\s+`-joined phrase.
const registryGuard = () =>
  between(
    RELEASE_TICKET,
    "count_registry() {",
    '[ -d "$entry" ] || continue',
    "release-ticket.sh",
  );

test("release-ticket.sh still spells the guard probe 3 cites the way probe 3 cites it (#870)", () => {
  assert.match(
    registryGuard(),
    phrase(`[ -r "${WTROOT}" ] && [ -x "${WTROOT}" ]`),
    "release-ticket.sh's count_registry no longer guards `$wtroot` with the `-r`/`-x` pair probe 3's comment names, so inflight.sh now cites a spelling that file does not have — and inflight.sh's own count_registry has an identically-shaped guard on its own `$wtroot`, so a reader who greps the cited words lands on the citing file's copy and reads it as the thing cited",
  );
});
