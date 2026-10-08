import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, stripHashGutter } from "./support/prose-pin.mjs";

// #800. Probe 3's comment borrows its establish-absence rule from a
// worktree-registry guard in another file and cited that check by LINE. The
// line it named had stopped being that check — it landed in unrelated prose —
// and no test read inflight.sh as text, so a green run said nothing about it.
//
// The convention that closes it is release-ticket.test.mjs's own: "The sites
// are named by construct throughout, never by line: they have moved every time
// this file was touched." So the citing-side pins below are a pair — the
// construct has to be named, and the form that rotted must not come back.
// Neither alone holds: the positive pin stays green beside a stray line
// citation, and the negative pin stays green if the whole clause is deleted.
//
// #870 adds the third pin, the only one on the TARGET side. A construct
// citation rots less often than a line citation, not never: a pure identifier
// rename in the cited file — zero behaviour change — left both pins above
// green while probe 3's prose named an identifier that file no longer had.
//
// The cited guard was release-ticket.sh's own registry count until #2146 moved
// every copy of that count into worktree.sh's Registration probe; probe 3 now
// cites the probe's `wt_count_registry`, which its worktree half reaches
// through `wt_counts`. One copy left means the misdirection #870 measured — a
// reader grepping the cited words landing on the CITING file's identically
// shaped guard — has no second copy to land on, but a rename still strands the
// citation, so the target-side pin stays.
//
// The identifier has exactly one literal spelling in this file: WTROOT, below.
// Both the citing-side phrase and the target-side phrase interpolate it, so the
// two pins cannot independently drift: renaming the identifier in worktree.sh
// alone reds the target side, and renaming WTROOT alone reds the citing side
// against inflight.sh's untouched prose.
//
// THE CEILING, same as reaping-prose.test.mjs: PRESENCE pins over a bounded
// slice. Text spliced INSIDE the pinned clause reddens them; a whole new
// sentence appended after one, carving out an exception, does not. Reflow stays
// green by design — the words are pinned, not their layout — on BOTH sides:
// the target-side pin goes through `phrase()` too.
const INFLIGHT = readFileSync(join(import.meta.dirname, "..", "plugin", "scripts", "inflight.sh"), "utf8");
const WORKTREE = readFileSync(join(import.meta.dirname, "..", "plugin", "scripts", "worktree.sh"), "utf8");

// The one literal spelling of the identifier the guard below protects.
const WTROOT = "$wt_root";

// Bounded at both ends, by the probe's own heading and by the function the
// comment documents, so a citation elsewhere in inflight.sh can neither satisfy
// the positive pin nor trip the negative one with probe 3's clause untouched.
const probe3 = () =>
  stripHashGutter(
    between(INFLIGHT, "# Probe 3 — a local worktree or branch.", "probe_local() {", "inflight.sh"),
  );

test("probe 3 names worktree.sh's worktree-registry guard by construct (#800)", () => {
  assert.match(
    probe3(),
    phrase(`worktree.sh's \`wt_count_registry\` applies with its \`-d\`/\`-r\`/\`-x\` guard on \`${WTROOT}\``),
    "probe 3 no longer names the check it borrows the establish-absence rule from, so a reader has nothing to follow to it",
  );
});

test("probe 3 cites the guard by construct, never by line (#800)", () => {
  assert.doesNotMatch(
    probe3(),
    /(?:worktree|release-ticket)\.sh:\d/,
    "a line-numbered citation is back in probe 3's comment — the next insertion in the cited file moves the content out from under the number",
  );
});

// The target side, bounded by `wt_count_registry`'s own opening and by the
// entry loop's `-d` skip below the guard. Both bounds are CODE: this pin's
// subject is code, and bounding it on a neighbouring COMMENT would make that
// prose load-bearing for this assertion. Read RAW, never through
// `stripHashGutter`: the `#` gutter is what stops a WRAPPED comment restating
// the guard from satisfying a `\s+`-joined phrase.
const registryGuard = () =>
  between(
    WORKTREE,
    "wt_count_registry() {",
    '[ -d "$wt_cr_entry" ] || continue',
    "worktree.sh",
  );

test("worktree.sh still spells the guard probe 3 cites the way probe 3 cites it (#870)", () => {
  assert.match(
    registryGuard(),
    phrase(`[ -d "${WTROOT}" ] && [ -r "${WTROOT}" ] && [ -x "${WTROOT}" ]`),
    "worktree.sh's wt_count_registry no longer guards `$wt_root` with the `-d`/`-r`/`-x` triple probe 3's comment names, so inflight.sh now cites a spelling that file does not have",
  );
});
