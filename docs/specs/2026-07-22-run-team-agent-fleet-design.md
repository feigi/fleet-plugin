# `/fleet:run-team` — implement / review / merge agent fleet

Date: 2026-07-22
Status: implemented

> **Superseded in part.** Packaging (2026-07-23) moved every artifact named
> here into the `fleet` plugin and made namespaced invocation mandatory. Paths
> and command names below have been updated in place. The design reasoning, and
> the probe results for agent naming and tool availability, remain valid — see
> `docs/specs/2026-07-23-fleet-plugin-design.md`.

> **Superseded in part.** Admissibility (2026-07-30) no longer gates on row size.
> Phase 0's *"admit light-row only"* step is deleted; the gate asks **is what to
> build decided?** instead. A heavy-row ticket with a complete Agent Brief is
> admissible, and a fleet member on that row enters at
> `superpowers:writing-plans`, skipping the maintainer-present
> `superpowers:brainstorming`. Candidate ordering is a script sort — oldest
> first — not a model re-rank. Phase 0's step 5 and the claims that depended on
> it have been removed below; everything else in this document still stands. See
> `docs/specs/2026-07-30-fleet-trust-the-label-design.md`.

> **Superseded in part.** In-flight probing (2026-07-23) is now a script call.
> Phase 0's *In-flight check* step below still names the three probes inline;
> `~/.claude/skills/fleet/scripts/inflight.sh` runs all three itself and exits
> 0 free, 1 taken, 2 the question could not be answered. The step is left as
> written, but do not run its commands as a fallback — bare `gh pr list
> --search` is a full-text match, so nearly every ticket reads as taken and free
> work is skipped silently, which is what PR #40 was filed to fix. See
> `docs/specs/2026-07-23-fleet-plugin-design.md`.

> **Superseded in part.** The candidate scan (2026-07-23) is now a script call.
> Phase 0's *Candidate scan* step below cites `next-ticket` step 1, which at the
> time was a raw `gh issue list` where `--label ready-for-agent` was the correct
> flag. `~/.claude/skills/fleet/scripts/candidates.mjs` now carries that query
> and spells it `--require-label ready-for-agent`; it refuses `--label` at exit 2
> rather than ignoring it, so the step below is corrected in place to the flag
> the script accepts. `--allow-fallback` is the switch that now holds the
> `next-ticket`/fleet divergence the step describes, and the fleet does not pass
> it. See `docs/specs/2026-07-23-fleet-plugin-design.md`.

Artifact: `~/.claude/skills/fleet/skills/run-team/SKILL.md` (repo `feigi/claude-config`)

## Problem

Three commands already cover one ticket end to end, but each is a separate
human-driven session:

| Command | Scope | Ends at |
|---|---|---|
| `next-ticket` (skill) | pick a ticket, implement it | PR open |
| `review-and-fix` (command) | review a PR, fix, push, go green | `ready-to-merge` label |
| `run-merge-bot` (command) | merge labeled PRs in numeric order | queue drained |

Running them one ticket at a time wastes the parallelism the repo supports —
tickets are mostly independent and each lives in its own worktree. `/fleet:run-team`
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

Reads `~/.claude/skills/fleet/commands/review-and-fix.md` and follows it: review, split
findings into apply-now and defer, fix, push, watch to green, file deferred
findings as issues, add `ready-to-merge`. Reports the label state and the
deferred issue numbers.

### Merge-bot — at most 1 at any moment

Spawned per wave, not kept alive. Reads `~/.claude/skills/fleet/commands/run-merge-bot.md`
and runs **one** pass: hold rule, no-undo audit, rebase, wait green, re-check the
label, merge, re-evaluate the queue. Exits when nothing is actionable.

It does **not** arm the persistent Monitor that `run-merge-bot.md` describes —
the controller owns that instead, so a dying subagent cannot take the watcher
with it and silently stop the queue.

### Why subagents read files instead of invoking slash commands

`review-and-fix` and `run-merge-bot` live in `~/.claude/skills/fleet/commands/`. Command
availability inside a subagent is not guaranteed the way skill availability is.
Handing the subagent an absolute file path to read is robust regardless.

### Every fleet agent MUST be spawned with a `name`

Non-negotiable, and silent if violated. Under
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (set in `~/.claude/settings.json:3`), a
`name` makes the agent a member of the session's implicit team, and team
membership is what carries the `Agent` tool. Probed 2026-07-22 on Claude Code
2.1.217, all four cells:

| shape | `Agent` tool | nested spawn |
|---|---|---|
| `general-purpose`, unnamed | not-resolved | — |
| `claude`, unnamed | not-resolved | — |
| `claude`, named | resolved | succeeded |
| `general-purpose`, named | resolved | succeeded |

`subagent_type` is irrelevant to delegation. Omit the name and the agent loses
the ability to delegate with **no error** — the tool is simply absent, and the
agent improvises something worse instead.

This is what makes the reviewer's inner fan-out legal: a reviewer can run
`/pr-review-toolkit:review-pr` with its full specialist set (`code-reviewer`,
`silent-failure-hunter`, `pr-test-analyzer`, `type-design-analyzer`,
`comment-analyzer`) without the controller owning the dispatch.

**Capability is not permission — the reviewer prompt must say so explicitly.**
Fleet members inherit the session's standing policy lines, observed verbatim in a
probed agent's own system prompt: *"Do not call the AgentTool unless the user
requested it"*. A reviewer holding the `Agent` tool may still decline to fan out,
correctly, because nothing in its prompt authorized it. So the reviewer prompt
must state that dispatching `review-pr`'s specialists IS the requested work. A
reviewer that silently reviews solo produces a thinner review with no error and
no signal that anything was skipped.

Two tools fleet members do NOT have, confirmed by probe: `Workflow` and
`TaskOutput`. A member cannot run a workflow, and cannot read another agent's
output — it only sees its own children's completion notifications. Any
cross-agent result routing goes through the controller.

Implementers inherit the same capability. Heavy-row work is admissible as of the
2026-07-30 design, and the heavy path ends in
`superpowers:subagent-driven-development`, so an implementer fans out too.

### Every implementer and reviewer gets a FRESH context

One agent, one unit of work, then gone. Two things this forbids:

- **Never `subagent_type: "fork"`.** A fork inherits the controller's full
  conversation — every other ticket's shortlist, every prior review, the whole
  design discussion. Fleet members get `general-purpose` or `claude`, never a
  fork.
- **Never reuse a finished agent for new work.** `SendMessage` to a completed
  agent resumes it *from its transcript*, carrying the previous ticket's context
  into the next one. Refilling a slot means spawning a NEW agent, not messaging
  the one that just freed it.

Naming follows the unit of work, which keeps freshness structural rather than a
thing to remember: `impl-<issue#>`, `review-pr-<pr#>`, `merge-bot-<wave#>`. A
name is never reused, so a stale agent can never be addressed by accident.
(Names are latest-wins — reusing one silently rebinds it to the newer agent.)

`SendMessage` to a fleet member remains correct for one purpose: pinging for a
report it owes, or resuming a reply truncated mid-task. That continues the SAME
unit of work and does not violate this rule.

The cost is real and accepted: every implementer re-reads its Agent Brief and
re-derives repo conventions from scratch. That is the price of no cross-ticket
contamination.

Two consequences for the controller:

- **Concurrency accounting.** Nested grandchildren consume harness agent slots
  the controller never dispatched. The ≤5/≤5/≤1 caps bound *fleet members*, not
  total live agents; a fleet at cap with every member fanning out is many more
  processes than eleven.
- **Stray notifications.** A grandchild surfaces to the main thread as its own
  task-notification, not only to its parent. The controller will see completions
  for agents it did not spawn and must not treat an unrecognized task-id as a
  fleet member reporting done.

## Command interface

```
/fleet:run-team [implementers] [reviewers]
```

Both optional, both default to 5, both capped at 5. `/fleet:run-team 3 2` runs three
implementers and two reviewers. The merge-bot is not configurable — it is
always at most one.

## Phases

### Phase 0 — shortlist

Runs at start, and again whenever the approved pool empties.

1. Candidate scan — `next-ticket` step 1, including the server-side label
   exclusion and the `--jq` body reduction. Never fetch raw bodies for the whole
   list; they are ~97% of the payload. **`--require-label ready-for-agent` is
   mandatory here, and there is no fallback.** `next-ticket` drops the label
   filter and retries against `ready-for-human` when the first query returns
   nothing; the fleet must NOT. Empty result means the fleet has no work, not
   that it should widen the net.
2. Dependency scan — `next-ticket` step 2, on the `d` array.
3. In-flight check — `next-ticket` step 3, all three probes per candidate
   (`gh pr list --state all --search`, `git ls-remote --heads origin`,
   `git worktree list` + `git branch -vv`). Any hit means the ticket is taken.
4. For each survivor, `gh issue view <N> --json title,body,comments --jq
   '.title, .body, (.comments[]|.author.login + ": " + .body)'` and read the
   `## Agent Brief`. Record its `Out of scope` sequencing constraints.
5. Judge each survivor **decided?** — would two competent implementers, reading
   only this ticket, build materially different things? Present the survivors as
   a multi-select; the maintainer ticks the approved pool. Excluded, not dropped.
   The criterion, the groups, and their ordering are set by
   `docs/specs/2026-07-30-fleet-trust-the-label-design.md`.

### Why the label boundary is hard

`ready-for-agent` means triage has already specified the ticket for an unattended
agent. `ready-for-human` means the opposite: it needs a human to brainstorm the
design first. The fleet has no channel to that human mid-flight, so it never
touches `ready-for-human` — those tickets reach the fleet only after a human
brainstorms them and triage re-labels.

Admissibility is a second, independent filter on top of that. A ticket can be
correctly labeled `ready-for-agent` and still be too open-ended to hand a
background implementer. The 2026-07-30 design settles that on *is what to build
decided?* — never on how big the ticket is — and makes the Agent Brief the
evidence rather than ruling it inadmissible. Both filters must pass.

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

Every implementer prompt carries, verbatim, the blockquoted blocks under
`## Phase 2 — dispatch implementers` in
`~/.claude/skills/fleet/skills/run-team/SKILL.md`. That skill is the
authoritative copy; this spec does not reproduce the blocks.

### Phase 3 — event loop

The controller reacts to events and never blocks on any single one:

- **Implementer completes** → verify the reported SHA is reachable on the
  expected branch → enqueue the PR for review → refill the slot from the
  approved pool (phase 1, then phase 2 for that ticket) by spawning a **new**
  agent under a new name. Never re-task the agent that just freed the slot.
- **Review slot free and a PR is queued** → dispatch a reviewer.
- **Reviewer completes having added the label** → merge-bot wave.
- **Monitor fires** on `ready-to-merge` appearing on any open PR → merge-bot
  wave. This catches labels added by hand, outside the fleet.
- **Approved pool empty** → phase 0 again, subject to the queue-depth rules
  below.

## Queue depth

The controller tracks two numbers:

- **pool** — approved tickets not yet dispatched
- **supply** — open `ready-for-agent` issues that survive BOTH the in-flight scan
  and the decided? check. A queue of undecided tickets counts as zero supply

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
exist nowhere else. Non-empty `git status --porcelain -unormal` → stop and
report — the explicit mode, never bare `--porcelain`, or
`status.showUntrackedFiles = no` reads an empty answer and licenses the
rebase over work this check exists to protect (#730).

**Agent Brief over body.** `gh issue view <n>` shows no comments. The brief
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

- Modifying `next-ticket`, `review-and-fix`, or `run-merge-bot`. `/fleet:run-team`
  orchestrates them as they are.
- Triage itself. The controller suggests; the maintainer runs it.
- Cross-repo operation. One repo per invocation.
- Resuming a fleet after the session ends. Worktrees, branches, `in-progress`
  labels, and open PRs all survive; the fleet does not. A fresh `/fleet:run-team`
  re-derives state from the in-flight scan.
