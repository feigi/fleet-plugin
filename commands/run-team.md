---
description: run an agent fleet — up to 5 implementers, up to 5 reviewers, one merge bot — over the ready-for-agent queue
argument-hint: [implementers] [reviewers]
---

Run `next-ticket`, `review-and-fix`, and `run-merge-bot` as one fleet. You are the
**controller** and you stay in the main thread — you never become a fleet member.

`$ARGUMENTS` is `[implementers] [reviewers]`, both optional, both defaulting to 5
and capped at 5. The merge bot is always at most one and is not configurable.

Design rationale: `~/.claude/docs/specs/2026-07-22-run-team-agent-fleet-design.md`.

## Two rules that fail silently if you break them

**Spawn every fleet member with a `name`.** A name makes the agent a member of the
session's implicit team, and team membership is what carries the `Agent` tool.
Omit it and the member loses the ability to delegate with no error — the tool is
simply absent and it improvises something worse. `subagent_type` is irrelevant to
this. Names follow the unit of work: `impl-<issue#>`, `review-pr-<pr#>`,
`merge-bot-<wave#>`.

**Give every member a fresh context.** One agent, one unit of work, then gone.
Never `subagent_type: "fork"` — a fork inherits your entire conversation. Never
re-task a finished agent: `SendMessage` resumes it from its transcript and drags
the previous ticket into the next one. Refilling a slot means spawning a *new*
agent under a *new* name. `SendMessage` stays correct for pinging a member for a
report it owes, or resuming a reply truncated mid-task — that is the same unit of
work.

## Phase 0 — shortlist

Run at start, and again whenever the approved pool empties.

1. Candidate scan, `next-ticket` step 1. **`--label ready-for-agent` is mandatory
   and there is no fallback.** `next-ticket` drops the label and retries against
   `ready-for-human` when the query comes back empty; you must not. Empty means
   the fleet has no work — `ready-for-human` tickets need a human to brainstorm
   the design first, and you have no channel to that human mid-flight.
2. Dependency scan, `next-ticket` step 2, on the `d` array. Open blocker → drop.
3. In-flight check, `next-ticket` step 3, all three probes per candidate:
   `gh pr list --state all --search "<N>"`, `git ls-remote --heads origin`,
   `git worktree list` + `git branch -vv`. Any hit means taken.
4. `gh issue view <N> --comments` per survivor. The `## Agent Brief` is
   authoritative over the body. Record its `Out of scope` sequencing constraints.
5. **Size each survivor and admit light-row only** (`next-ticket` step 6's table).
   Light row — states exactly what to change, one or two files, no open design
   choice — is admissible. Heavy row — ambiguity in *what* to build, more than ~3
   files, new API/schema/UX, several viable approaches — is not, even with a
   complete Agent Brief. Torn between rows → take the heavier one and exclude.
6. Present the admissible survivors, best first, as a multi-select. The maintainer
   ticks the approved pool. List excluded heavy-row tickets separately as "needs a
   solo session with you" — excluded, not dropped.

Never put two sequenced tickets in the same wave. That constraint lives in the
Agent Brief's `Out of scope`, is invisible to step 2's `depends on #N` scan, and
bites hardest at five wide.

## Phase 1 — claim and isolate

Serial, in the main checkout, per approved ticket. Never parallel, never inside a
member — concurrent `worktree add` and label writes race.

```bash
gh issue edit <N> --add-label in-progress
git worktree add .worktrees/<N>-slug -b <type>/<N>-slug origin/main
(cd .worktrees/<N>-slug && npm install)
```

Infer the branch/worktree convention from `git worktree list` and `git branch -r`
rather than assuming; in agent-brain it is `feat|fix|refactor/<N>-slug` and
`.worktrees/<N>-slug`.

## Phase 2 — dispatch implementers

One named member per approved ticket, up to the cap, in the background. Each
prompt carries the ticket number, the worktree absolute path, the branch, and
both of these verbatim:

> You are ALREADY in worktree `<abs-path>` on branch `<branch>`. Do NOT create
> another worktree. Verify with `git rev-parse --git-dir` and
> `git rev-parse --git-common-dir`. Skip the using-git-worktrees skill's Step 1.

> Read the issue with `gh issue view <N> --comments`. The `## Agent Brief` comment
> is authoritative over the issue body. Honor its `Respec` block — it may
> explicitly rule out hypotheses the body raises.

Enter `next-ticket` at **step 6** — steps 1–5 are already done. The member sizes
the ticket, implements, runs step 7 (rebase onto `origin/main`, re-run tests,
push, `gh pr create` with `Closes #N` and exactly one release label), then reports
its PR number and head SHA and exits. It never adds `ready-to-merge` and never
merges.

## Phase 3 — event loop

React to events; never block on one.

- **Implementer completes** → verify the reported SHA is reachable on the expected
  branch → enqueue the PR for review → refill the slot from the approved pool
  (phase 1, then phase 2) with a **new** agent under a new name.
- **Review slot free and a PR queued** → dispatch a reviewer.
- **Reviewer completes having labeled the PR** → merge-bot wave.
- **Monitor fires** on `ready-to-merge` appearing → merge-bot wave. This catches
  labels you add by hand.
- **Approved pool empty** → phase 0 again, subject to queue depth below.

### Reviewers

One named member per PR, never the agent that implemented it. Hand it the PR
number and tell it to read `~/.claude/commands/review-and-fix.md` and follow it —
give the file path, not a slash invocation; command availability inside a member
is not guaranteed the way skill availability is.

**Authorize the fan-out explicitly.** Members inherit the session's standing
policy line *"Do not call the AgentTool unless the user requested it."* A reviewer
holding the `Agent` tool will otherwise decline to dispatch `review-pr`'s
specialists — correctly, since nothing authorized it — and you get a thinner solo
review with no error and no signal anything was skipped. State in the prompt that
running `/pr-review-toolkit:review-pr` with its full specialist set IS the
requested work.

### Merge bot

Spawn per wave, named `merge-bot-<wave#>`, never two at once. Tell it to read
`~/.claude/commands/run-merge-bot.md` and run **one** pass — hold rule, no-undo
audit, rebase, wait green, re-check the label, merge — then exit.

**You own the watcher, not the bot.** `run-merge-bot.md` ends by arming a
persistent 60s Monitor; instruct the member to skip that. A dying member would
take the watcher with it and the queue would stop silently. Arm one Monitor
yourself, `persistent: true`, seeded before the loop so PRs already handled do not
re-fire.

## Queue depth

Track two numbers:

- **pool** — approved tickets not yet dispatched
- **supply** — open `ready-for-agent` issues surviving both the in-flight scan and
  light-row sizing. A queue full of heavy-row tickets is zero supply.

Low-water mark is the implementer cap. On a freed slot:

| pool | supply | action |
|---|---|---|
| ≥ 1 | — | dispatch from pool, silent |
| 0 | ≥ cap | re-shortlist, ask the maintainer to tick |
| 0 | < cap | re-shortlist **and** suggest `/triage` |
| 0 | 0 | suggest `/triage`, hold implementer slots idle |

`/triage` is `disable-model-invocation: true` — user-invoked only — so suggest,
never run it. The suggestion is a report, not a blocking prompt:

> ready-for-agent down to 2 workable. 14 in needs-triage, 3 in needs-info. Run
> `/triage`?

Counts come from the same cheap `gh issue list --search` shape, no bodies. A
starved implementer queue never stalls the review or merge side.

## Invariants

- ≤ 5 implementers, ≤ 5 reviewers, ≤ 1 merge bot. These bound *fleet members*, not
  total live agents — members fan out, and their children consume harness slots
  you never dispatched.
- A grandchild surfaces to you as its own task-notification. An unrecognized
  task-id is not a fleet member reporting done.
- A reviewer never reviews a PR it implemented.
- The merge bot only touches PRs whose implementer has reported done. Rebasing a
  worktree someone is still working in destroys uncommitted work.
- `ready-to-merge` is added by a reviewer only — never an implementer, never you.
- Phase 1 is serial. Everything else may run concurrently.

## Guards

**Verify every reported SHA.** A member can create its own nested worktree and
commit there, leaving the SHA on a stray branch while its report looks perfectly
normal. Check `git log --oneline origin/<branch>` before enqueueing for review.
Not reachable → flag it, do not enqueue, do not return the ticket to the pool
until the maintainer rules on it.

**Never `--delete-branch`.** `gh pr merge <n> --delete-branch` either errors on a
`main` held by another worktree or silently strands the feature worktree on
`main`. Merge with `gh pr merge <n> --merge` alone; GitHub deletes the remote
branch anyway.

**Never force a rebase to start.** No `git clean`, `git checkout .`, or
`git reset --hard`. A worktree's uncommitted changes may exist nowhere else.
Non-empty `git status --porcelain` → stop and report.

**Cross-check what members report about their own environment.** They are wrong
often enough to matter, and a confident wrong report from a reviewer flips a
verdict.

## Failure handling

| Failure | Response |
|---|---|
| SHA not on expected branch | Flag, do not enqueue, report |
| Implementer blocked or ambiguous | Free the slot, leave `in-progress`, report |
| Reviewer cannot reach green | Report, leave the PR unlabeled, free the slot |
| Merge bot hits the hold rule | Report `held-behind-#<lower>`, PR stays queued |
| Merge bot cannot resolve a rebase safely | Stop that PR, report, continue |
| Member silent or truncated | `SendMessage` to ping or resume — same unit of work |

A red PR never silently becomes `ready-to-merge`.

## Report

One running table, updated as events land:

```
#N  ticket   impl-<N>       PR #M  review-pr-<M>   label:yes  merged
#N  ticket   impl-<N>       PR #M  review-pr-<M>   label:no   -        red CI
#N  ticket   impl-<N>       -      -               -          -        blocked: SHA off-branch
```

Plus a queue-depth line: pool, supply, and whether triage was suggested.

## Red flags

- "I'll just fork the controller so the member has context" → fork inherits
  everything. Fresh context, always.
- "This member finished, I'll send it the next ticket" → that resumes its
  transcript. Spawn a new one.
- "The name is cosmetic" → the name is what carries the `Agent` tool.
- "ready-for-agent came back empty, I'll widen to ready-for-human" → no. Empty
  means no work.
- "The Agent Brief is thorough, this heavy ticket is fine" → both filters must
  pass. Brief quality does not promote a heavy row.
- "The reviewer has the Agent tool, it'll fan out" → not unless you authorize it.
- "The member reported the SHA, so the commit is on the branch" → verify it.
- "I'll let the merge bot arm its own monitor" → it dies, the queue stops.
