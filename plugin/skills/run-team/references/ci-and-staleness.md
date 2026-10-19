# CI reading and staleness

Why green not verdict, why absence is its own verdict, why conclusion not
stable, why behind-count only honest signal, why the tick runs on every wake
and why the beat is shaped as it is. Assertions live in SKILL.md's wake table,
**Nothing to do: arm the beat** and **Own the CI waits**; evidence here.

## Own the CI waits — members cannot hold across a run

Members turn-based, cannot hold across ten-minute run — rebase, push, stop. One
went idle three times in two minutes doing this; every re-ping told nothing I
could not read. So controller arms second persistent Monitor over open PRs'
latest runs, keyed `<run-id>:<attempt>:<conclusion>` so each terminal state
fires once, emits behind-count with it: `success` on branch 8 behind not
actionable, that distinction most of traffic.

Members are turn-based and cannot hold across a ten-minute
run — they rebase, push, stop.

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
absence earns it, judged at the PR's base commit: no `.github/workflows/`
directory there, or one holding no workflow files. Every failure to *read* a
workflow — the path not a directory, a workflow blob not read whole, files
present under names other than `--workflow`, two files sharing that name, no
GitHub repository gh resolves from the cwd's git remotes — is exit 2, "could
not be answered", never `no-ci`. So a repo whose CI is merely misconfigured
can never borrow the declarable verdict.

Absence never means pass. `no-ci` alone exits **1**, same bucket as `not-green`
— nothing to be green, and not red either. Exit 0 comes only with the caller's
`--declare-no-ci`, saying the gate is satisfied by their own verified suite run.
That flag is caller-side: it is echoed into `reasons` and flips the exit code,
so re-running with it and finding it there confirms only that you passed it,
never that anyone verified anything.

Why controller needs the verdict by name: no workflow run will ever complete
here, so the CI-run-completion edge never fires and waiting on it stalls the
whole PR — the silent-stall shape reported before this verdict existed.
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

**A conclusion is not stable, even for a fixed run id on an unchanged head.** A
rerun rewrites the run in place, so never cache a conclusion; key watchers on
`<run-id>:<attempt>:<conclusion>`. Leaving `attempt` out of the key is the bug
that looks like it works: a rerun that lands on the *same* conclusion regenerates
an already-seen key and fires nothing, so the second failure is silent and reads
exactly like a run still in progress. **Building that key with jq's `//` is the
same bug in the opposite direction**: `ci-state` reports an in-progress run as
`conclusion: ""`, and `//` catches `null` and `false` but never the empty
string, so `.conclusion // "-"` passes `""` straight through, keys a RUNNING job
as terminal and fires a spurious not-green — measured in four separate runs,
including one where the controller then had to re-arm blind. Test any fallback
you write against `""`, `null` AND a real conclusion, and check it still lets
the real one through: `map(if . == null or . == "" then "-" else tostring end)`.
Also: the newest
run on a branch is frequently *not* CI, so `--limit 1` can hide the CI result
entirely.

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

## Beat when there is nothing to do, and never end your turn on a drained queue

**Beat when there is nothing to do, and never end your turn on a drained
queue.** You cannot be woken. A backgrounded Monitor does not wake an idle
agent — measured twice, see **A member runs its test suite in the foreground** in references/member-lifecycle.md, where `fix-pr-<M>` backgrounded a suite plus a Monitor and sat idle for
roughly two hours — and `run-merge-bot.md`'s CI gate states the general rule:
"whatever wakes you is external and may never come". So hold the wait yourself,
exactly the way that gate does:

## Tick on every wake

**Why every wake.** A merge cascade is a firehose of merges, CI greens and
rebases that holds your attention on the merge side while the implementer side
drains to 0 and stays there — 0 implementers emit no completion event, so a
refill that waited for one would never fire. A tick on every wake you are
already handling is what makes that drain visible. **Every wake is still an
edge, so none covers a fully drained queue**: no members and no open PRs is no
event at all, and the tick goes unrun. That state is the heartbeat's.

## The beat's ceiling is a real bound

The interval doubles while the fleet asks for nothing and stops at `--ceiling`,
so a quiet night costs ~26 wakes instead of ~96. **The ceiling is a real bound,
not a formality**: supply grows from OUTSIDE the fleet — a ticket you triage,
one a reviewer filed `needs-triage` included — and that arrival emits no
event either, so the ceiling is your worst-case latency for noticing it.
Do not raise it past 30 minutes.

## When you stop on purpose, say why

The beat leaves a dated mark on every hold, so a run
that dies abruptly (a crashed harness, a closed terminal, an OOM kill) is
detected by its mark going stale. A run that stops KNOWINGLY can do better
than being detected, and nothing else can write the reason afterwards:

```bash
~/.fleet/bin/fleet-run fleet-heartbeat.mjs --stop "budget exhausted"
```
