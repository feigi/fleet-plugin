# CI State

## What it is for

One script, [`ci-state.mjs`](../../plugin/scripts/ci-state.mjs), that
binds a CI run to a PR's exact head SHA and answers a single question
honestly: is this PR's CI genuinely green, right now? The
[Reviewer](reviewer.md)'s CI check, the [Finisher](finisher.md)'s heavy-
job check, and the [Merge bot](merge-bot.md)'s two `merge-gate.mjs`
reads all call it rather than reading `gh pr checks` directly.

## How it works
1. **Locate.** `ci-state.mjs --pr <n> [--base <ref>]
   [--declare-no-ci]` locates the repo's CI workflow by name (default
   `CI`, overridable via `--workflow`/`--workflow-file`).
2. **Bind.** It reads every job GitHub's API reports for the run bound
   to the PR's *current* head SHA — nothing is cached, since a rerun
   rewrites a run's conclusions in place with no new push.
3. **Classify:** **green** (every expected job present and passed, the
   list derived from the workflow file itself), **not-green** (any
   failure, or a job missing from what the workflow declares), or
   **`no-ci`** (genuinely no workflow directory/file — a declared
   absence, never inferred from a read error).
4. **Exit.** 0 = gate satisfied (green, or `no-ci` *with*
   `--declare-no-ci`); 1 = not satisfied (not green, or `no-ci` without
   the declaration — absence never reads as pass); 2 = the question
   itself couldn't be answered.

## Opinionated choices

- **Absence must be declared, never inferred.** `--declare-no-ci`
  exists because a repo with no CI configured and a repo whose CI is
  merely misconfigured must never collapse into the same "no-ci,
  proceed" answer.
- **Head-SHA binding is not optional.** `gh pr checks`'s own failure
  mode is aggregating conclusions *across* runs, so a `pass` inherited
  from a cancelled run on a superseded SHA reads as green without this
  script's re-query.
- **Three exit codes, not two** — the same reason
  [Instruments](instruments.md) splits "changed" from "could not
  answer": a caller needs to know whether the tree said no, or whether
  the question was never actually asked.
