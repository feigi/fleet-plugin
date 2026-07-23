# CI reading and staleness

Why a green is not a verdict, why a conclusion is not stable, and why
behind-count is the only honest signal. The assertions these justify live in
SKILL.md's Phase 3 event loop and Merge bot sections; the evidence is here.

## Own the CI waits — members cannot hold across a run

Members are turn-based and cannot hold across a ten-minute run — they rebase,
push, stop. One went idle three times in two minutes doing this, and every
re-ping told me nothing I could not read. That is why the controller arms a
second persistent Monitor over open PRs' latest runs, keyed
`<run-id>:<conclusion>` so each terminal state fires once, and emits the
behind-count with it: a `success` on a branch 8 behind is not actionable, and
that distinction is most of the traffic.

## Run-binding: take the whole row from one read

Take run id, head and conclusion from **one** `gh run list --json` row. A watcher
that reads them separately stitches an event from two moments and can stream
`RUN COMPLETE: success` under a run id whose real job list is a failure. This is
the four-way binding `ci-state.mjs` performs — `gh pr checks` aggregates
conclusions ACROSS runs and can report a `pass` inherited from a cancelled run on
a superseded SHA; head-SHA binding alone misses it, because the head is right and
only the conclusions belong elsewhere. Tell members a monitor event is a wake-up,
never a verdict — they re-query `gh run view <rid> --json jobs` at labelling time.

## A conclusion is not stable, even for a fixed run id on an unchanged head

A rerun rewrites the run **in place** — `attempt` increments, dependents are
re-marked `skipped` in zero seconds, and their prior conclusions are gone.
Verified: three jobs went `success` → `skipped` with nothing pushed, after a
refresh workflow re-ran the currency check. So never cache a conclusion; key
watchers on `<run-id>:<conclusion>`, and check `attempt` before trusting one.
`started_at == completed_at` on a job means re-marked, not re-run. Nothing in
`ci-state.mjs` is cached for the same reason: the only safe design is to re-query
at the moment of decision.

## `--limit 1` hides CI

The newest run on a branch is frequently *not* CI — a label or policy workflow
often lands later, so `--limit 1` can hide the CI result entirely.

## Stale green: every merge invalidates every other open PR

`rebase-check` fails fast when behind and gates the slow jobs, so the rest show
*stale green* until something re-triggers, then flip to `rebase-check: FAILURE`
with `integration`/`mutation` **skipped**. `rebase-check` can itself be
stale-**green**. Behind-count is the only honest signal. And one rebase per PR at
merge time is enough: reviewers label on their own green without requiring
currency, and requiring it earlier costs a full CI cycle per sibling merge — six
wasted cycles in one run. Any behind-count you hand a bot is expired on arrival.
