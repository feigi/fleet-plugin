import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

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
// this file was touched." So the pins below are a pair — the construct has to
// be named, and the form that rotted must not come back. Neither alone holds:
// the positive pin stays green beside a stray line citation, and the negative
// pin stays green if the whole clause is deleted.
//
// The negative pin forbids a citation FORM, not a vocabulary: a bare
// `release-ticket.sh` is exactly what the positive pin requires, so the
// accepting case is pinned here too rather than assumed.
//
// THE CEILING, same as reaping-prose.test.mjs: PRESENCE pins over a bounded
// slice. Text spliced INSIDE the pinned clause reddens them; a whole new
// sentence appended after one, carving out an exception, does not. Reflow stays
// green by design — the words are pinned, not their layout.
const REPO = join(import.meta.dirname, "..", "..", "..");
const INFLIGHT = readFileSync(join(REPO, "skills", "fleet", "scripts", "inflight.sh"), "utf8");

// A shell comment block wraps at `#`, so a pinned phrase can break across lines
// with the comment gutter, not whitespace, at the break — `\s+` does not span a
// `#`. Strip the gutter and rejoin with a single space, exactly the inter-word
// space a wrap point replaces.
const stripHashGutter = (text) => text.split("\n").map((l) => l.replace(/^\s*#\s?/, "")).join(" ");

// Bounded at both ends, by the probe's own heading and by the function the
// comment documents. inflight.sh names release-ticket.sh elsewhere, and an
// unbounded slice would let one of those satisfy the positive pin, or trip the
// negative one, with probe 3's clause untouched.
const probe3 = () =>
  stripHashGutter(
    between(INFLIGHT, "# Probe 3 — a local worktree or branch.", "probe_local() {", "inflight.sh"),
  );

test("probe 3 names release-ticket.sh's worktree-registry guard by construct (#800)", () => {
  assert.match(
    probe3(),
    phrase("release-ticket.sh's `-r`/`-x` guard on `$wtroot`"),
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
