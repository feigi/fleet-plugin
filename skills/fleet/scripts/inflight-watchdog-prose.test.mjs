import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

// #346 asked for one thing that no behaviour test can hold: that the fate of
// the per-transport knobs be DECIDED rather than left implicit. The watchdog
// bounds every transport, which makes ConnectTimeout, the ServerAlive pair and
// the lowSpeed keys redundant AS THE BOUND — so keeping them is a choice, and a
// choice with no reason written beside it decays into an accident nobody dares
// touch. The reason is the artifact; this file is what keeps it.
//
// A pair, like inflight-ssh-precedence-prose.test.mjs's. The positive pins
// carry the decision and its grounds; the negative pin refuses the wording that
// was true before the watchdog landed and is a lie after it. Neither holds
// alone — the positive pins survive a stale "this is still open" sentence
// spliced back in beside them, and the negative pin survives the whole
// rationale being deleted.
//
// THE CEILING: presence pins over a bounded slice. Text spliced INSIDE a pinned
// clause reddens them; a new sentence appended beside one does not. Reflow stays
// green by design — the words are pinned, not their layout.
const INFLIGHT = readFileSync(join(import.meta.dirname, "inflight.sh"), "utf8");

// Same one-liner as the other prose files here, deliberately duplicated rather
// than hoisted: a shell comment block wraps at `#`, so a pinned phrase can break
// across lines with the comment gutter, not whitespace, at the break — `\s+`
// does not span a `#`. Strip the gutter and rejoin with the single inter-word
// space a wrap point replaces.
const stripHashGutter = (text) => text.split("\n").map((l) => l.replace(/^\s*#\s?/, "")).join(" ");

// Bounded by the http paragraph's own opening and by the first construct that
// follows the comment block. Probe 2 is the only place in this script that
// discusses http transport options, but the bounds are what stop a later block
// elsewhere from satisfying these pins with this clause gutted.
const httpRationale = () =>
  stripHashGutter(
    between(
      INFLIGHT,
      "# http: lowSpeedLimit/lowSpeedTime is git's (curl's) own bound",
      "base_ssh=$(git config --get core.sshCommand",
      "inflight.sh",
    ),
  );

test("probe 2's comment states that the per-transport knobs are kept, and why", () => {
  const text = httpRationale();
  assert.match(text, phrase("stay anyway, and that is a decision rather than an oversight"),
    "#346 required the knobs' fate to be stated outright — a reader must not have to infer it from the fact that the lines are still there");
  assert.match(text, phrase("fails earlier than the watchdog and in git's own words"),
    "the first ground for keeping them: git's own diagnostic is the more useful thing to read, and the watchdog can only report that a budget elapsed");
  assert.match(text, phrase("would make every ssh stall wait out the full budget"),
    "the second ground, and the one that makes removal an actual regression rather than a wash");
});

// The negative half. Before the watchdog, probe 2's comment closed by saying the
// gap was still open and named the issue that would close it. That sentence is
// now false, and false in the most expensive direction: it would send the next
// reader off to implement the watchdog that the same comment block introduces.
test("probe 2's comment no longer defers the bound to a ticket this script now carries", () => {
  const text = httpRationale();
  assert.doesNotMatch(text, phrase("Closing that needs a bound outside git"),
    "the bound is no longer needed, it is present — this wording describes the tree as it stood before the watchdog");
  assert.doesNotMatch(text, /can still hold a fleet slot/,
    "an https origin cannot: the watchdog bounds it whatever the transport does, which is what inflight.test.mjs measures against a silent listener");
});
