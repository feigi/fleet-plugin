# CI reading and staleness

Why green not verdict, why absence is its own verdict, why conclusion not
stable, why behind-count only honest signal. Assertions live in SKILL.md
Phase 3 event loop + Merge bot sections; evidence here.

## Own the CI waits — members cannot hold across a run

Members turn-based, cannot hold across ten-minute run — rebase, push, stop. One
went idle three times in two minutes doing this; every re-ping told nothing I
could not read. So controller arms second persistent Monitor over open PRs'
latest runs, keyed `<run-id>:<attempt>:<conclusion>` so each terminal state
fires once, emits behind-count with it: `success` on branch 8 behind not
actionable, that distinction most of traffic.

## Run-binding: take the whole row from one read

Take run id, head, conclusion from **one** `gh run list --json` row. Watcher
reading them separately stitches event from two moments, can stream
`RUN COMPLETE: success` under run id whose real job list is failure. This is the
four-way binding `ci-state.mjs` performs — `gh pr checks` aggregates conclusions
ACROSS runs, can report `pass` inherited from cancelled run on superseded SHA;
head-SHA binding alone misses it, because head right and only conclusions belong
elsewhere. Tell members monitor event is wake-up, never verdict — they re-query
`gh run view <rid> --json jobs` at labelling time.

## `no-ci`: absence is its own verdict, never green and never red

Third verdict `ci-state.mjs` emits, alongside `green`/`not-green`. Only genuine
absence earns it: no `.github/workflows/` directory, or one holding no workflow
files. Every failure to *read* a workflow — directory unreadable, target
unreadable, files present under names other than `--workflow`, two readable
files sharing that name, no resolvable repo root — is exit 2, "could not be
answered", never `no-ci`. So a repo whose CI is merely misconfigured can never
borrow the declarable verdict.

Absence never means pass. `no-ci` alone exits **1**, same bucket as `not-green`
— nothing to be green, and not red either. Exit 0 comes only with the caller's
`--declare-no-ci`, saying the gate is satisfied by their own verified suite run.
That flag is caller-side: it is echoed into `reasons` and flips the exit code,
so re-running with it and finding it there confirms only that you passed it,
never that anyone verified anything.

Why controller needs the verdict by name: no workflow run will ever complete
here, so the CI-run-completion edge never fires and waiting on it stalls the
whole PR — the silent-stall shape #111 reported before this verdict existed.
SKILL.md's `no-ci` edge therefore dispatches the finisher off the reviewer's
final verdict instead — that edge, not this file, carries the conditions on it.
Under `no-ci` the script reads no run list and no run view: no workflow, nothing
to bind.

## A conclusion is not stable, even for a fixed run id on an unchanged head

Rerun rewrites run **in place** — `attempt` increments, dependents re-marked
`skipped` in zero seconds, prior conclusions gone. Verified: three jobs went
`success` → `skipped` with nothing pushed, after refresh workflow re-ran
currency check. So never cache conclusion; key watchers on
`<run-id>:<attempt>:<conclusion>`. `started_at == completed_at` on job means
re-marked, not re-run. Nothing in `ci-state.mjs` cached for same reason: only
safe design is re-query at moment of decision.

## `--limit 1` hides CI

Newest run on branch frequently *not* CI — label or policy workflow often lands
later, so `--limit 1` can hide CI result entirely.

## Stale green: every merge invalidates every other open PR

`rebase-check` fails fast when behind, gates slow jobs, so rest show *stale
green* until something re-triggers, then flip to `rebase-check: FAILURE` with
`integration`/`mutation` **skipped**. `rebase-check` can itself be
stale-**green**. Behind-count only honest signal. And one rebase per PR at merge
time enough: reviewers label on own green without requiring currency, and
requiring it earlier costs full CI cycle per sibling merge — six wasted cycles
in one run. Any behind-count you hand bot expired on arrival.