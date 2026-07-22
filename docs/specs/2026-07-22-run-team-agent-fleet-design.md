# `/run-team` — implement / review / merge agent fleet

Date: 2026-07-22
Status: approved design, not yet implemented
Artifact: `~/.claude/commands/run-team.md` (repo `feigi/claude-config`)

## Problem

Three commands already cover one ticket end to end, but each is a separate
human-driven session:

| Command | Scope | Ends at |
|---|---|---|
| `next-ticket` (skill) | pick a ticket, implement it | PR open |
| `review-and-fix` (command) | review a PR, fix, push, go green | `ready-to-merge` label |
| `run-merge-bot` (command) | merge labeled PRs in numeric order | queue drained |

Running them one ticket at a time wastes the parallelism the repo supports —
tickets are mostly independent and each lives in its own worktree. `/run-team`
runs many at once under a single controller.

## Central conflict, and how it resolves

`next-ticket` step 4 is emphatic: *suggest, then stop; never grab a ticket
unilaterally*, because claims exist that git and GitHub do not record. Five
implementers each running the skill unmodified would either block on five
separate prompts or race onto the same tickets.

Resolution: **the controller runs `next-ticket` steps 1–4 exactly once**, in the
main thread, and gates on the maintainer there. Implementers never run ticket
selection at all — they enter at step 5 with a ticket already assigned. The rule
is preserved rather than bent: exactly one human decision per wave, zero
unilateral grabs.

## Roles

### Controller — the main thread

Not a subagent. Holds the shortlist, the approved pool, slot bookkeeping, the
worktree creation, and the label Monitor. Every token-heavy operation is pushed
into a subagent so the controller's context survives a long session.

### Implementer — up to 5 concurrent

Input: one issue number, one pre-created worktree absolute path, one branch name.

Enters `next-ticket` at **step 6** (size the ticket) — steps 1–5 are already
done by the controller. Implements at the depth the ticket warrants, runs step 7
(rebase, re-test, push, `gh pr create`), reports PR number and head SHA, exits.

Never adds `ready-to-merge`. Never merges.

### Reviewer — up to 5 concurrent

Input: one PR number. Never a PR the same agent implemented.

Reads `~/.claude/commands/review-and-fix.md` and follows it: review, split
findings into apply-now and defer, fix, push, watch to green, file deferred
findings as issues, add `ready-to-merge`. Reports the label state and the
deferred issue numbers.

### Merge-bot — at most 1 at any moment

Spawned per wave, not kept alive. Reads `~/.claude/commands/run-merge-bot.md`
and runs **one** pass: hold rule, no-undo audit, rebase, wait green, re-check the
label, merge, re-evaluate the queue. Exits when nothing is actionable.

It does **not** arm the persistent Monitor that `run-merge-bot.md` describes —
the controller owns that instead, so a dying subagent cannot take the watcher
with it and silently stop the queue.

### Why subagents read files instead of invoking slash commands

`review-and-fix` and `run-merge-bot` live in `~/.claude/commands/`. Command
availability inside a subagent is not guaranteed the way skill availability is.
Handing the subagent an absolute file path to read is robust regardless.

## Command interface

```
/run-team [implementers] [reviewers]
```

Both optional, both default to 5, both capped at 5. `/run-team 3 2` runs three
implementers and two reviewers. The merge-bot is not configurable — it is
always at most one.

## Phases

### Phase 0 — shortlist

Runs at start, and again whenever the approved pool empties.

1. Candidate scan — `next-ticket` step 1 verbatim, including the server-side
   label exclusion and the `--jq` body reduction. Never fetch raw bodies for the
   whole list; they are ~97% of the payload.
2. Dependency scan — `next-ticket` step 2, on the `d` array.
3. In-flight check — `next-ticket` step 3, all three probes per candidate
   (`gh pr list --state all --search`, `git ls-remote --heads origin`,
   `git worktree list` + `git branch -vv`). Any hit means the ticket is taken.
4. For each survivor, `gh issue view <N> --comments` and read the `## Agent
   Brief`. Record its `Out of scope` sequencing constraints.
5. Present ~10 survivors, best first, as a multi-select. The maintainer ticks the
   approved pool.

Two sequenced tickets never go into the same wave. That constraint lives in the
Agent Brief's `Out of scope` section and is invisible to the `depends on #N`
body scan step 2 performs — with five tickets in flight it is exactly the
collision that bites.

### Phase 1 — claim and isolate

Serial, in the main checkout, per approved ticket. Concurrent `worktree add` and
label writes race, so this never runs in parallel and never runs inside a
subagent.

```bash
gh issue edit <N> --add-label in-progress
git worktree add .worktrees/<N>-slug -b <type>/<N>-slug origin/main
(cd .worktrees/<N>-slug && npm install)
```

Branch and worktree naming follow the repo's existing convention, inferred from
`git worktree list` / `git branch -r`. In agent-brain that is
`feat|fix|refactor/<N>-slug` and `.worktrees/<N>-slug`.

### Phase 2 — dispatch

Spawn up to the implementer cap, one per approved ticket, in the background.

Every implementer prompt carries, verbatim:

> You are ALREADY in worktree `<abs-path>` on branch `<branch>`. Do NOT create
> another worktree. Verify with `git rev-parse --git-dir` and
> `git rev-parse --git-common-dir`. Skip the using-git-worktrees skill's Step 1.

and:

> Read the issue with `gh issue view <N> --comments`. The `## Agent Brief`
> comment is authoritative over the issue body. Honor its `Respec` block — it may
> explicitly rule out hypotheses the body raises.

### Phase 3 — event loop

The controller reacts to events and never blocks on any single one:

- **Implementer completes** → verify the reported SHA is reachable on the
  expected branch → enqueue the PR for review → refill the slot from the
  approved pool (phase 1, then phase 2 for that ticket).
- **Review slot free and a PR is queued** → dispatch a reviewer.
- **Reviewer completes having added the label** → merge-bot wave.
- **Monitor fires** on `ready-to-merge` appearing on any open PR → merge-bot
  wave. This catches labels added by hand, outside the fleet.
- **Approved pool empty** → phase 0 again, subject to the queue-depth rules
  below.

## Queue depth

The controller tracks two numbers:

- **pool** — approved tickets not yet dispatched
- **supply** — open `ready-for-agent` issues surviving the in-flight scan

Low-water mark is the implementer cap. On a freed slot:

| pool | supply | action |
|---|---|---|
| ≥ 1 | — | dispatch from pool, silent |
| 0 | ≥ cap | re-shortlist, ask the maintainer to tick |
| 0 | < cap | re-shortlist **and** suggest `/triage` |
| 0 | 0 | suggest `/triage`, hold implementer slots idle |

`/triage` is `disable-model-invocation: true` — user-invoked only — so
suggesting is the only legal move. The suggestion is a report, not a blocking
prompt:

> ready-for-agent down to 2 workable. 14 in needs-triage, 3 in needs-info. Run
> `/triage`?

Counts come from the same cheap `gh issue list --search` shape, no bodies. A
starved implementer queue never stalls the review or merge side — in-flight
reviewers and the merge-bot keep running while implementer slots sit idle.

## Invariants

- At most 5 implementers, at most 5 reviewers, at most 1 merge-bot.
- Never two merge-bots concurrently.
- A reviewer never reviews a PR it implemented.
- The merge-bot only touches PRs whose implementer has reported done. Rebasing a
  worktree an implementer is still working in destroys uncommitted work.
- `ready-to-merge` is added by a reviewer only — never an implementer, never the
  controller.
- Phase 1 is serial. Everything else may run concurrently.

## Guards

**SHA verification.** A dispatched implementer can create its own nested
worktree and commit there, leaving the reported SHA on a stray branch that looks
identical in the agent's report. The controller re-checks every reported SHA
with `git log --oneline origin/<branch>` before enqueueing the PR for review. Not
reachable → flag it, do not enqueue, do not free the ticket back into the pool
until the maintainer rules on it.

**No `--delete-branch`.** `gh pr merge --delete-branch` misbehaves in a
worktree-based checkout: it either errors on a `main` held by another worktree,
or silently strands the feature worktree on `main`. The merge-bot merges with
`gh pr merge <n> --merge` alone; GitHub deletes the remote branch anyway.

**No destructive rebase prep.** Never `git clean`, `git checkout .`, or
`git reset --hard` to make a rebase start. A worktree's uncommitted changes may
exist nowhere else. Non-empty `git status --porcelain` → stop and report.

**Agent Brief over body.** `gh issue view <n>` shows only the body. The brief
lives in a comment and can invert the body's framing; working from the body
alone burns a whole ticket confirming code that is already correct.

## Failure handling

| Failure | Response |
|---|---|
| Implementer SHA not on expected branch | Flag, do not enqueue for review, report to maintainer |
| Implementer reports blocked or ambiguous | Free the slot, leave `in-progress` on the issue, report |
| Reviewer cannot reach green after its fix loops | Report, leave the PR unlabeled, free the slot |
| Merge-bot hits the hold rule | Report `held-behind-#<lower>`, PR stays queued, move on |
| Merge-bot hits a rebase conflict it cannot resolve safely | Stop that PR, report, continue with the rest |
| Subagent reply truncated mid-task | Resume it with `SendMessage` rather than re-dispatching |

A red PR never silently becomes `ready-to-merge`.

## Report format

One running table, updated as events land:

```
#N  ticket   impl:<agent>  PR #M  review:<agent>  label:yes  merge:merged
#N  ticket   impl:<agent>  PR #M  review:<agent>  label:no   merge:-        red CI
#N  ticket   impl:<agent>  -      -               -          -             blocked: SHA off-branch
```

Plus a queue-depth line: pool, supply, and whether triage was suggested.

## Out of scope

- Modifying `next-ticket`, `review-and-fix`, or `run-merge-bot`. `/run-team`
  orchestrates them as they are.
- Triage itself. The controller suggests; the maintainer runs it.
- Cross-repo operation. One repo per invocation.
- Resuming a fleet after the session ends. Worktrees, branches, `in-progress`
  labels, and open PRs all survive; the fleet does not. A fresh `/run-team`
  re-derives state from the in-flight scan.
