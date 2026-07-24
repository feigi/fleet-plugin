# Member lifecycle: naming, fresh context, recovery

Why member name load-bearing, why every member single-use, how killed/idle/truncated member recovered. Assertions these justify live in SKILL.md's "Two rules that fail silently", Phase 3, Reviewers, Failure handling sections; evidence here.

## The name is what carries the `Agent` tool

Name makes it team member; membership carries `Agent` tool. Omit it → member loses delegation, no error, improvises something worse. `subagent_type` irrelevant — name is mechanism, not label. Names follow unit of work: `impl-<issue#>`, `review-pr-<pr#>`, `merge-bot-<wave#>`.

## Members cannot name their children

Named member passing `name` fails with `teammates cannot spawn teammates`, so specialists dispatched **unnamed**. Must state in reviewer prompt — else reviewer hits error, concludes fan-out unavailable, silently downgrades to solo review, no error, no signal.

## Capability is not permission

Members inherit standing *"Do not call the AgentTool unless the user requested it."* Else reviewer declines to dispatch specialists — correctly — you get thinner solo review, no error, no signal. Having tool (capability) not authorization to use it (permission); reviewer prompt must state full specialist set IS requested work.

## Fresh context per member

One agent, one unit of work, gone. Never re-task finished agent — `SendMessage` resumes its transcript, drags old ticket in. Refill = **new** agent, **new** name. `SendMessage` still right for pinging member for report it owes, or resuming truncated reply, never for handing finished agent next ticket.

## Grandchildren surface to you, not to the member that spawned them

Specialist's report routes to *you*, controller; completed agent's final text is return value, lost if unconsumed. Ruling on specialist report as "your finding" to reviewer makes it verify report it never sent or act on one it cannot check — so name source, send its *text*, tell reviewers to ping each specialist rather than assume delivery. Grandchild surfaces as own task-notification; unrecognized task-id not a member reporting done.

## Killed vs idle vs truncated

Killed member cannot be resumed — row most often got wrong. `SendMessage` works on idle or truncated; does nothing for dead, and spend limit kills every member at once, so temptation to re-task peaks exactly when it cannot work. Recovery = fresh agent, fresh name (`impl-<N>-b`, `review-pr-<M>-b`), whose prompt states what it inherits:

- committed-and-pushed vs committed-only vs **uncommitted in the worktree**
- uncommitted work exists nowhere else — no `git clean`, `git checkout .`,
  `git reset --hard`, `git stash drop`
- for half-finished review: which specialists already reported, so it doesn't
  re-run 40-minute fan-out

Reviewers go idle waiting on CI, won't resume alone — rebased, pushed, stopped with run `in_progress`. Three of five in one run. Recovery there = **finisher, not a re-review**, whenever commits already pushed.

## React to artifacts, not agents

Liveness says nothing: `idle` means "not currently executing", not "done"; finished member's finding may never arrive. In one run every member that looked dead had its work in git or on PR — pushed commits, self-removed label, applied ruling. Read `gh pr view`, `gh run view`, `git -C <worktree> status` before messaging: one command settles what round-trip usually doesn't, and member that ignored one ping tends to ignore second. When you message, send specific next action, never "what is your status".