# CI reading and staleness

Label names in this file are roles; the Label map gives the string to type; a member never derives the map.

Why green not verdict, why absence is its own verdict, why conclusion not
stable, why behind-count only honest signal, why the tick runs on every wake
and why the beat is shaped as it is. Assertions live in SKILL.md's wake table,
**Nothing to do: mark the beat and end your turn** and **Own the CI waits**; evidence here.

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

## Mark the beat when there is nothing to do, and end your turn

**Mark the beat when there is nothing to do, and end your turn.** Nothing
outside your own process can start a turn in an idle session. A backgrounded
Monitor does not wake an idle
agent — measured twice, see **A member runs its test suite in the foreground** in references/member-lifecycle.md, where `fix-pr-<M>` backgrounded a suite plus a Monitor and sat idle for
roughly two hours — and `run-merge-bot.md`'s CI gate states the general rule:
"whatever wakes you is external and may never come". So the wake-up is not a
watcher and not a cron entry. It is an omp extension loaded into your own
session, the alarm, which polls from inside the process and starts a turn once
the beat has fallen due.

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

The beat leaves a dated mark on every call, so a run
that dies abruptly (a crashed harness, a closed terminal, an OOM kill) is
detected by its mark going stale. A run that stops KNOWINGLY can do better
than being detected, and nothing else can write the reason afterwards:

```bash
~/.fleet/bin/fleet-run fleet-heartbeat.mjs --stop "budget exhausted"
```

Skipping it is not fatal — the next reader still reports the stop, it just
reports that the beat stopped *without a recorded reason*, which is all it can
honestly say about a death that named nothing.

## Nothing to do: why the beat, and what its lines mean

- **Nothing to do right now** → mark the beat and end your turn (SKILL.md's
  **Nothing to do: mark the beat and end your turn**). The beat is what the
  alarm reads: with no recorded mark its gate never passes, so a turn that
  ends without one is the stall itself — the level-check you are one command
  away from never runs. Listed on its own because it is the only wake that is
  not an event — every other row of SKILL.md's wake list reports something
  that happened; this one is the beat falling due.

- `… beat NOT marked …` — the write did not land, the file is degraded and
  was left as it is, or the run's `.fleet` directory could not be resolved and
  the mark went to a cwd-relative file the alarm may not read. No alarm is
  armed for this beat (an earlier mark still on disk is all the alarm can fire
  on), so do not take the line as a beat; fix what it names and run the
  command again.

**The beat does not stop on idleness.** An empty shortlist and an empty supply are
not a reason to end the run; they are the state a newly triaged ticket arrives
into. The run ends when you drain it, when the budget goes, or when this
context does — not because there was briefly nothing to do.
Zeroes on the cockpit are not yet proof the pipeline is idle.

## Rule: record, tick, act, beat

**Rule: record, tick, act, beat.** Every wake — a member report, a review
notification, a label, a CI run reaching a terminal state, a `CONFLICT` line, a
heartbeat, the maintainer's drain — is one `fleet-event.mjs` call, which makes
the wake's writes and ends in one `fleet-tick.mjs` invocation, and you do what
it prints. There are no hand-run
refill or dispatch edges left. Record first, because the tick reads the run off
`.fleet/ledger.md` and nothing else of yours: a wake you have not written down is
one it cannot see, and it names the same dispatch again. Every record goes
through `ledger.mjs` (references/ledger.md), which `fleet-event.mjs` drives — never a
hand edit. What each kind writes is in the header comment of `fleet-event.mjs`.

## The merge bot does not wait for the finisher's report

The `ready-to-merge` Monitor catches hand-added labels as well as a finisher's
own. The bot does not wait for that finisher's report: its rebase is
server-side, `gh pr update-branch --rebase`, so nothing on the finisher's
worktree has to happen first. **You own the watcher, not the bot.** Arm one
yourself, `persistent: true`, seeded before the loop so handled PRs do not
re-fire. **One rebase per PR, at merge time.** Any behind-count you hand a bot
is expired on arrival; say so.
