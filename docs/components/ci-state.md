# CI State

## What it is for

One script, [`ci-state.mjs`](../../plugin/scripts/ci-state.mjs), that
binds a CI run to a PR's exact head SHA and answers a single question
honestly: is this PR's CI genuinely green, right now? Every gate that
needs a CI verdict — the [Reviewer](reviewer.md)'s CI Monitor, the
[Finisher](finisher.md)'s heavy-job check, the [Merge bot](merge-bot.md)'s
wait and its two `merge-gate.mjs` reads — calls it rather than reading
`gh pr checks` directly.

## How it works

`ci-state.mjs --pr <n> [--base <ref>] [--declare-no-ci]` locates the
repo's CI workflow by name (default `CI`, overridable via
`--workflow`/`--workflow-file`), reads every job GitHub's API reports for
the run bound to the PR's *current* head SHA, and classifies the result:
**green** (every expected job present and passed, the list derived from
the workflow file itself so a skipped job never hides silently),
**not-green** (any failure, or a job missing from what the workflow
declares), or **`no-ci`** (genuinely no workflow directory or no matching
workflow file — a declared absence, never inferred from a read error).
Nothing is cached — a rerun rewrites a run's conclusions in place with no
new push, so every call re-queries at the moment of decision. Exit 0
means the gate is satisfied (green, or `no-ci` *with*
`--declare-no-ci` asserting the caller verified some other way); exit 1
means not satisfied (not green, or `no-ci` without the declaration —
absence never reads as pass); exit 2 means the question itself couldn't
be answered (unreadable workflow directory, malformed YAML, an
unattributable API response) and callers must not treat that as either
verdict.

## Opinionated choices

Absence must be *declared*, never inferred: `--declare-no-ci` exists
because a repo with no CI configured and a repo whose CI is merely
misconfigured (an unreadable `.github/workflows/`) must never collapse
into the same "no-ci, proceed" answer — the fleet's gates are exactly
what would be blinded by that conflation. Head-SHA binding is not
optional: `gh pr checks`'s own failure mode is aggregating conclusions
*across* runs, so a `pass` inherited from a cancelled run on a superseded
SHA reads as green without this script's re-query. Three exit codes, not
two, for the same reason [Instruments](instruments.md) splits "changed"
from "could not answer" — a caller needs to know whether the tree said
no, or whether the question was never actually asked.
