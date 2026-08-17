# CI reading and staleness

Why green not verdict, why conclusion not stable, why behind-count only honest
signal. Assertions live in SKILL.md Phase 3 event loop + Merge bot sections;
evidence here.

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