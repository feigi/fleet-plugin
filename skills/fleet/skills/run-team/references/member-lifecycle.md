# Member lifecycle: naming, fresh context, recovery

Why a member's name is load-bearing, why every member is single-use, and how a
killed, idle, or truncated member is recovered. The assertions these justify live
in SKILL.md's "Two rules that fail silently", Phase 3, Reviewers, and Failure
handling sections; the evidence is here.

## The name is what carries the `Agent` tool

The name makes it a team member, and membership is what carries the `Agent` tool.
Omit it and the member loses delegation with no error and improvises something
worse. `subagent_type` is irrelevant to this — the name is the mechanism, not a
label. Names follow the unit of work: `impl-<issue#>`, `review-pr-<pr#>`,
`merge-bot-<wave#>`.

## Members cannot name their children

A named member passing a `name` fails with `teammates cannot spawn teammates`, so
specialists are dispatched **unnamed**. This must be stated in the reviewer prompt
— otherwise the reviewer hits the error, concludes fan-out is unavailable, and
silently downgrades to a solo review with no error and no signal.

## Capability is not permission

Members inherit the standing *"Do not call the AgentTool unless the user requested
it."* A reviewer will otherwise decline to dispatch specialists — correctly — and
you get a thinner solo review with no error and no signal. Having the tool
(capability) is not authorization to use it (permission); the reviewer prompt must
state that the full specialist set IS the requested work.

## Fresh context per member

One agent, one unit of work, gone. Never re-task a finished agent — `SendMessage`
resumes its transcript and drags the old ticket in. Refill = **new** agent, **new**
name. `SendMessage` is still right for pinging a member for a report it owes, or
resuming a truncated reply, but never for handing a finished agent the next
ticket.

## Grandchildren surface to you, not to the member that spawned them

A specialist's report routes to *you*, the controller, and a completed agent's
final text is a return value lost if unconsumed. Ruling on a specialist report as
"your finding" to the reviewer makes it verify a report it never sent or act on
one it cannot check — so name the source and send its *text*, and tell reviewers
to ping each specialist rather than assume delivery. A grandchild surfaces as its
own task-notification; an unrecognized task-id is not a member reporting done.

## Killed vs idle vs truncated

A killed member cannot be resumed — the row most often got wrong. `SendMessage`
works on idle or truncated; it does nothing for dead, and a spend limit kills
every member at once, so the temptation to re-task peaks exactly when it cannot
work. Recovery is a fresh agent, fresh name (`impl-<N>-b`, `review-pr-<M>-b`),
whose prompt states what it inherits:

- committed-and-pushed vs committed-only vs **uncommitted in the worktree**
- that uncommitted work exists nowhere else — no `git clean`, `git checkout .`,
  `git reset --hard`, `git stash drop`
- for a half-finished review: which specialists already reported, so it does not
  re-run a 40-minute fan-out

Reviewers go idle waiting on CI and will not resume alone — rebased, pushed,
stopped with the run `in_progress`. Three of five in one run. Recovery there is a
**finisher, not a re-review**, whenever the commits are already pushed.

## React to artifacts, not agents

Liveness says nothing: `idle` means "not currently executing", not "done"; a
finished member's finding may never arrive. In one run every member that looked
dead had its work in git or on the PR — pushed commits, a self-removed label, an
applied ruling. Read `gh pr view`, `gh run view`, `git -C <worktree> status`
before messaging: one command settles what a round-trip usually does not, and a
member that ignored one ping tends to ignore a second. When you message, send the
specific next action, never "what is your status".
