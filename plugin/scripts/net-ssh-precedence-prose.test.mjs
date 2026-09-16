import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, stripHashGutter } from "./prose-pin.mjs";

// #350. The ssh-hardening comment said its options "land on top of"
// whatever the user's own ssh command already says. That reads as override, and
// the mechanism is the exact opposite: the options are appended LAST, and ssh
// takes the FIRST value of a repeated -o, so a user who has set ConnectTimeout
// or BatchMode keeps theirs and the value net_git sets is discarded. A
// reader trusting the old sentence believed the 10s bounded every run. Measured,
// OpenSSH_10.2p1: `ssh -o ConnectTimeout=45 -o ConnectTimeout=10 -G` reports
// connecttimeout 45, and against the accept-then-silent listener a user
// ConnectTimeout of 3 cut the connection at 3.0s, one of 25 at 25.0s, and the
// call's own 10s applied only with none set.
//
// The BEHAVIOUR is deliberate and stays — reversing the order would silently
// override a user's proxy or timeout config — so the whole defect lives in the
// prose, and prose is the only place it can be pinned.
//
// A pair, like inflight-citation-prose.test.mjs's citing-side pins: the
// corrected claims must be present, and the form that rotted must not come
// back. Neither alone holds — the positive pins survive a stray "lands on top
// of" spliced back in, and the negative pin survives the whole clause being
// deleted.
//
// THE CEILING, same as that file's: PRESENCE pins over a bounded slice. Text
// spliced INSIDE a pinned clause reddens them; a whole new sentence appended
// beside one does not. Reflow stays green by design — the words are pinned, not
// their layout.
//
// The negative pin is a word test, so it cannot tell the claim from a mention of
// it: a future sentence here recounting what the comment USED to say would
// redden it. Measured, and accepted — that history belongs here and on the
// commit, not in the script. Measured too, and deliberately not refused: "on top
// of" without "land" stays green, so the comment keeps the phrase for the
// non-precedence claims it already makes.
const NET = readFileSync(join(import.meta.dirname, "net.sh"), "utf8");

// Bounded at both ends, by net_git's own heading and by the first construct the
// comment documents. net.sh discusses ssh options in that one comment alone, but
// the bounds are what keep a later block elsewhere from satisfying these pins
// with the clause gutted.
const netGit = () =>
  stripHashGutter(
    between(
      NET,
      "# net_git <wdfile> <budget> <git arg>... — run one `git` network call",
      "net_base_ssh=$(git config --get core.sshCommand",
      "net.sh",
    ),
  );

test("net_git states ssh's first-wins rule for a repeated -o (#350)", () => {
  assert.match(
    netGit(),
    phrase("ssh takes the FIRST value of a repeated -o"),
    "net.sh no longer states which of two repeated -o values ssh uses, so nothing in the comment tells a reader whether the options it appends bound the run or are discarded",
  );
});

test("net_git names the consequence: the user's own bound is the one that applies (#350)", () => {
  assert.match(
    netGit(),
    phrase("the bound degrades to whatever bound the user asked for"),
    "net.sh states the first-wins rule without its consequence — a reader can still believe the ConnectTimeout this probe sets is what bounds a run where the user set their own",
  );
});

test("net_git documents the BatchMode=no opt-out and what GIT_TERMINAL_PROMPT=0 does not cover (#350)", () => {
  const text = netGit();
  assert.match(
    text,
    phrase("`-o BatchMode=no`"),
    "net.sh no longer documents that a user's own BatchMode=no survives, which is the setting that re-opens the prompt #92 exists to stop",
  );
  assert.match(
    text,
    phrase("GIT_TERMINAL_PROMPT=0 does not reach"),
    "net.sh no longer says that GIT_TERMINAL_PROMPT=0 leaves ssh's own host-key and passphrase prompts alone, so a reader takes the unconditional GIT_TERMINAL_PROMPT=0 as covering them",
  );
});

test("net_git never describes its options as landing on top of the user's (#350)", () => {
  assert.doesNotMatch(
    netGit(),
    /land(s|ing)?\s+on\s+top\s+of/i,
    "the override framing is back in net_git's comment — ssh is first-wins, so options appended after the user's own are defaults the user overrides, and this phrasing states the reverse of what was measured",
  );
});
