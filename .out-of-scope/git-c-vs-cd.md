# Replacing Per-Call `git -C` With One `cd`

The repo's shell scripts point a git call at a known tree with `git -C "$dir"`, never a
`cd "$dir"`. We don't accept proposals to collapse one script's per-call `-C` into a
single `cd "$dir"` followed by plain `git …` in any one script. The first one arrived as
a review suggestion against `pin-drift.sh`.

## Why this is out of scope

**It is the repo's convention, and a top-level `cd` would be the odd one out.** Eight
scripts in `plugin/scripts/` and `.github/scripts/` call `git -C` — real call sites, not
comment mentions or the one line that echoes it as a string — from 1 in `reap.sh` up to
13 in `no-undo-audit.sh` (2 in `worktree-audit.sh`, 3 in `derive-testcmd.sh`, 4 in
`pin-drift.sh`). None of them changes its own working directory. `cd` shows up in four
of the other scripts too — `claim-ticket.sh`, `instruments.sh`, `no-undo-audit.sh`,
`release-ticket.sh` — always inside a `$(cd … && …)` or `(cd … && …)` that resolves one
path or runs one command and exits, never as a bare statement outliving it. The only
`cd` whose effect outlives its own subshell is `smoke-omp.sh`'s, and that subshell is
itself backgrounded with `( … ) &`, so the calling script's own cwd still never moves. A
script that `cd`s at top level — outside any subshell — would give readers a second
idiom to check for: whether a later relative path or non-git command still means what
it meant before the `cd`.

**`-C` states the target at the call site.** Each `git -C "$root" …` line says which
tree it asks about, without the reader tracking cwd back through the file. The failure
this family of scripts has actually hit is git answering about a different tree than
intended. `reap.sh`, `release-ticket.sh` and `no-undo-audit.sh` each record, with
measurements, how an ambient `GIT_WORK_TREE`/`GIT_DIR` overrides `-C`. A `cd` does not
fix that either: those variables override discovery from cwd just the same. So the
rewrite trades an explicit per-call target for an implicit one and gains no safety.

**There is no defect.** The proposal was a `simplify` suggestion that a differential
harness had verified as behavior-equivalent. It was not a failure report. By the time
it was triaged, the review pass that produced it had already consolidated
`pin-drift.sh` from six `$root`-dependent lines to four `git -C "$root"` calls, and
shellcheck is clean on the file. The same reasoning `review-pr-micro-refactors.md`
applies to `workflows/review-pr.js` holds here: changing a file for tidiness alone, on
code a review just touched, is not accepted.

## What would reopen this

Either of these:

- A measured defect caused by per-call `-C`, such as a call site that points at the
  wrong tree because one `-C` was missed.
- A deliberate decision to change the convention across every script. That is a
  repo-wide change with its own ticket, not a one-script rewrite.

## Prior requests

- #1847 — "Deferred from PR #1830 review: pin-drift.sh repeats git -C "$root" seven times instead of one cd" (`simplify` dimension)
