# Main-checkout probe stderr noise

`headMove` in `main-checkout.mjs` reads a baseline commit as `missing` only when
`git rev-parse -q --verify B^{commit}` exits 1 with nothing on stderr. Any stderr,
including output unrelated to the object (an operator's `GIT_TRACE=1`, a config warning,
a wrapper banner), keeps the answer at could-not-look (cause `read`). Two proposals to
make that test ignore unrelated noise are refused:

- **Count only `error:`/`fatal:` stderr lines.** A real fault that prints only a
  `warning:` line would then read as `missing`, whose advice is to re-record. That is the
  unsafe direction #3138 closed.
- **Strip `GIT_TRACE*` from the probe's env.** `gitEnv()` removes only `GIT_DIR` and
  `GIT_WORK_TREE`, so `GIT_TRACE` does reach the child. But stripping `GIT_TRACE*` misses
  `GIT_TRACE2*`, `GIT_CURL_VERBOSE` and config warnings, so it fixes one source of noise
  and leaves the rule unchanged.

## Why this is out of scope

The noisy case fails closed. Measured on current `main` (git 2.50.1): record a baseline on
an unpushed commit, amend it, `git reflog expire --expire=now --all`,
`git gc --prune=now`, then `--check`.

- Plain run: `MAIN-CHECKOUT-UNKNOWN baseline commit … is missing from this repository …`,
  with the examine-HEAD-against-origin/main advice, exit 2.
- With `GIT_TRACE=1`: `MAIN-CHECKOUT-UNKNOWN could not look: git rev-parse --verify exited
  1: … trace: built-in: git rev-parse -q --verify '…^{commit}'`, with the
  never-re-baseline advice, exit 2.

Dispatch is held in both runs. Only the advice differs, `why` prints the noise line, and
once the noise is gone the next tick gives the `missing` advice. The trigger is also
narrower than "GIT_TRACE is set": the existing test sets `GIT_TRACE=<file path>`, and
trace output then goes to that file, not stderr. Only a trace aimed at stderr (`1`, `2`,
`true`), a config warning or a wrapper banner flips the answer.

#3138's ruled Agent Brief made empty versus non-empty stderr the discriminator, and
`headMove`'s docblock names this case ("output unrelated to the object such as
GIT_TRACE's"). The test "a baseline commit whose probe read fails for another reason than
absence stays could-not-look" pins it. Both remedies above were measured worse in the
review of #3439 and recorded on #3441. Reopening the discriminator would mean accepting
either the `warning:`-only risk or the incomplete env strip.

## What reopens it

A fleet run where routine stderr noise, not an operator's debug trace, hides `missing` on
every tick; or a way to detect absence that does not depend on stderr and does not move an
unreadable object to `missing`.

## Prior requests

- #3441 — unverified[0] from PR #3439's review (correctness lens), refuted.
- #3442 — "main-checkout headMove: unrelated stderr such as GIT_TRACE on an absent baseline
  commit reads as could-not-look, not missing" (the same claim from the silent-failure lens).
