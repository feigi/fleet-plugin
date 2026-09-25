# Replacing Per-Call `git -C` With One `cd`

The repo's shell scripts point each git call at its tree with `git -C "$dir"`. We don't
accept proposals to collapse those into a single `cd "$dir"` followed by plain `git …` in
any one script. The first one arrived as a review suggestion against `pin-drift.sh`.

## Why this is out of scope

**It is the repo's convention, and a top-level `cd` would be the odd one out.** Eight
scripts in `plugin/scripts/` and `.github/scripts/` call `git -C` (from 4 call sites in
`reap.sh`, `worktree-audit.sh`, `derive-testcmd.sh` and `pin-drift.sh` up to 15 in
`no-undo-audit.sh`). None of them changes its working directory. The only executable
`cd` in either directory is in `smoke-omp.sh`, and it runs inside a `( … ) &` subshell
so the script's own cwd never moves. A script that `cd`s at top level would give
readers a second idiom to check for: whether a later relative path or non-git command
still means what it meant before the `cd`.

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
shellcheck is clean on the file. That is the bar `review-pr-micro-refactors.md` already
sets: changing a file for tidiness alone, on code a review just touched, is not
accepted.

## What would reopen this

Either of these:

- A measured defect caused by per-call `-C`, such as a call site that points at the
  wrong tree because one `-C` was missed.
- A deliberate decision to change the convention across every script. That is a
  repo-wide change with its own ticket, not a one-script rewrite.

## Prior requests

- #1847 — "Deferred from PR #1830 review: pin-drift.sh repeats git -C "$root" seven times instead of one cd" (`simplify` dimension)
