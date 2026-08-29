// #415. `inflight.sh` sets `set -eu`, then runs each probe as `probe_X || :`.
// POSIX exempts a function's whole execution from `-e` while its status is what
// an `||` is testing, so `-e` reaches no line of any probe body. Nothing fails
// open today — every status-producing command in the three bodies carries its
// own guard — but the next edit inside a probe is where that stops being true,
// and an editor adding a command stands at the wrapper.
//
// So all three wrappers carry the rule, and this pins it at all three rather
// than at whichever one a reader happens to open. That is the failure shape
// worth guarding: the rule surviving at one site while another loses it reads
// as covered, and the site an editor is standing at is the one that matters.
// `between` is bounded at both ends here, so a block deleted outright fails on
// its own missing bound rather than being satisfied by a sibling's copy.
//
// The clauses pinned are the ones an editor ACTS on, not the prose around them:
// that `-e` does not reach inside; that a verdict-feeding command needs its own
// `add_unknown …; return 1` naming that probe's key; that leaving it unguarded
// frees a ticket that is taken (the unsafe direction, which is why this is not
// tidiness); and that a command which cannot change the verdict must record no
// unknown — the distinction `probe_pr`'s `raw="?"` count already embodies, and
// the one a rule stated without it would get wrong on first use.
//
// The enforcement for the rule's BEHAVIOUR is in inflight.test.mjs ("probe 3: a
// branch LOOKUP that could not run is unknown, never free"), which reddens when
// a guard is actually removed. This file only pins that the rule is stated.
//
// THE CEILING: these are PRESENCE pins over a bounded slice. Text spliced inside
// a pinned phrase reddens them; a sentence appended after one, carving out an
// exception, does not. A reflow stays green by design — `phrase` matches across
// the comment gutter that a re-wrap moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, stripHashGutter } from "./prose-pin.mjs";

const SH = readFileSync(join(import.meta.dirname, "inflight.sh"), "utf8");

// Keyed by the probe's own name and the `unknown` key it records under, so a
// block copied between sites without its key being updated is a failure here
// rather than a guard pointing at the wrong probe.
const PROBES = [["probe_pr", "pr"], ["probe_remote", "remote"], ["probe_local", "local"]];

const rule = (probe) =>
  stripHashGutter(between(SH, `ADDING A COMMAND TO ${probe}`, `${probe} || :`, "inflight.sh"));

for (const [probe, key] of PROBES) {
  test(`${probe}'s wrapper says \`set -e\` does not reach inside the body`, () => {
    assert.match(rule(probe), phrase("`set -e` does not reach inside the body"));
    // Named as the shells the script actually runs under, because the claim is
    // shell semantics and a reader who assumes it is a bash quirk will discount it.
    assert.match(rule(probe), phrase("measured under /bin/sh, /bin/dash and /bin/bash"));
    // `-u` is NOT exempted, and an editor who reads "`set -eu` guards nothing
    // here" as covering both would skip a guard it does still provide.
    assert.match(rule(probe), phrase("`-u` is not exempted and still aborts"));
  });

  test(`${probe}'s wrapper demands a guard naming its own \`${key}\` key`, () => {
    assert.match(rule(probe), phrase("A command that feeds a verdict field therefore carries its own"));
    assert.match(rule(probe), phrase(`add_unknown "${key}"`));
  });

  test(`${probe}'s wrapper names the unsafe direction, not just the failure`, () => {
    // The whole severity argument: an unguarded failure is not a loud abort.
    assert.match(rule(probe), phrase("gets reported as a definite absence"));
    assert.match(rule(probe), phrase("frees a ticket that is taken"));
    assert.match(rule(probe), phrase("a free verdict puts a second agent on the ticket where a taken one only skips it"));
  });

  test(`${probe}'s wrapper exempts a command that cannot change the verdict`, () => {
    assert.match(rule(probe), phrase("A command that cannot change the verdict is the opposite case and must record no unknown"));
    assert.match(rule(probe), phrase('`probe_pr`\'s `raw="?"` count already has'));
  });
}

// The exemption the rule points at has to still be the shape it describes: a
// tally guarded with `|| raw="?"` rather than an `add_unknown`. If that count
// ever starts recording an unknown, every one of the blocks above is teaching
// the distinction off an example that no longer holds.
test("the count the rule cites is still guarded without recording an unknown", () => {
  const tally = between(SH, 'raw=$(printf', 'if [ -n "$pr" ]', "inflight.sh");
  assert.match(tally, /\|\|\s*raw="\?"/);
  assert.doesNotMatch(tally, /add_unknown/);
});
