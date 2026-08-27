import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

// #350. Probe 2's ssh-hardening comment said its options "land on top of"
// whatever the user's own ssh command already says. That reads as override, and
// the mechanism is the exact opposite: the options are appended LAST, and ssh
// takes the FIRST value of a repeated -o, so a user who has set ConnectTimeout
// or BatchMode keeps theirs and the value this probe sets is discarded. A
// reader trusting the old sentence believed the 10s bounded every run. Measured,
// OpenSSH_10.2p1: `ssh -o ConnectTimeout=45 -o ConnectTimeout=10 -G` reports
// connecttimeout 45, and against the accept-then-silent listener a user
// ConnectTimeout of 3 cut the connection at 3.0s, one of 25 at 25.0s, and the
// probe's own 10s applied only with none set.
//
// The BEHAVIOUR is deliberate and stays — reversing the order would silently
// override a user's proxy or timeout config — so the whole defect lives in the
// prose, and prose is the only place it can be pinned.
//
// A pair, like inflight-citation-prose.test.mjs's: the corrected claims must be
// present, and the form that rotted must not come back. Neither alone holds —
// the positive pins survive a stray "lands on top of" spliced back in, and the
// negative pin survives the whole clause being deleted.
//
// THE CEILING, same as that file's: PRESENCE pins over a bounded slice. Text
// spliced INSIDE a pinned clause reddens them; a whole new sentence appended
// beside one does not. Reflow stays green by design — the words are pinned, not
// their layout.
//
// The negative pin is a word test, so it cannot tell the claim from a mention of
// it: a future sentence in probe 2 recounting what the comment USED to say would
// redden it. Measured, and accepted — that history belongs here and on the
// commit, not in the script. Measured too, and deliberately not refused: "on top
// of" without "land" stays green, so probe 2 keeps the phrase for the
// non-precedence claims it already makes.
const INFLIGHT = readFileSync(join(import.meta.dirname, "inflight.sh"), "utf8");

// Same one-liner as inflight-citation-prose.test.mjs, deliberately duplicated
// rather than hoisted: a shell comment block wraps at `#`, so a pinned phrase
// can break across lines with the comment gutter, not whitespace, at the break
// — `\s+` does not span a `#`. Strip the gutter and rejoin with a single space,
// exactly the inter-word space a wrap point replaces.
const stripHashGutter = (text) => text.split("\n").map((l) => l.replace(/^\s*#\s?/, "")).join(" ");

// Bounded at both ends, by the probe's own heading and by the first construct
// the comment documents. inflight.sh discusses ssh options in probe 2 alone,
// but the bounds are what keep a later block elsewhere from satisfying these
// pins with probe 2's clause gutted.
const probe2 = () =>
  stripHashGutter(
    between(
      INFLIGHT,
      "# Probe 2 — a remote branch carrying the number as its own path segment.",
      "base_ssh=$(git config --get core.sshCommand",
      "inflight.sh",
    ),
  );

test("probe 2 states ssh's first-wins rule for a repeated -o (#350)", () => {
  assert.match(
    probe2(),
    phrase("ssh takes the FIRST value of a repeated -o"),
    "probe 2 no longer states which of two repeated -o values ssh uses, so nothing in the comment tells a reader whether the options it appends bound the run or are discarded",
  );
});

test("probe 2 names the consequence: the user's own bound is the one that applies (#350)", () => {
  assert.match(
    probe2(),
    phrase("the bound degrades to whatever bound the user asked for"),
    "probe 2 states the first-wins rule without its consequence — a reader can still believe the ConnectTimeout this probe sets is what bounds a run where the user set their own",
  );
});

test("probe 2 documents the BatchMode=no opt-out and what GIT_TERMINAL_PROMPT=0 does not cover (#350)", () => {
  const text = probe2();
  assert.match(
    text,
    phrase("`-o BatchMode=no`"),
    "probe 2 no longer documents that a user's own BatchMode=no survives, which is the setting that re-opens the prompt #92 exists to stop",
  );
  assert.match(
    text,
    phrase("GIT_TERMINAL_PROMPT=0 does not reach"),
    "probe 2 no longer says that GIT_TERMINAL_PROMPT=0 leaves ssh's own host-key and passphrase prompts alone, so a reader takes the unconditional GIT_TERMINAL_PROMPT=0 as covering them",
  );
});

test("probe 2 never describes its options as landing on top of the user's (#350)", () => {
  assert.doesNotMatch(
    probe2(),
    /land(s|ing)?\s+on\s+top\s+of/i,
    "the override framing is back in probe 2's comment — ssh is first-wins, so options appended after the user's own are defaults the user overrides, and this phrasing states the reverse of what was measured",
  );
});
