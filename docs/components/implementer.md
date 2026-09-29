# Implementer

## What it is for

The implementer is the member that turns one claimed ticket into a
pushed branch and an open PR. It runs as
[`fleet-implementer.agent.md`](../../plugin/agents/fleet-implementer.agent.md),
or, on every 5th Pull by ledger count, its byte-identical sibling
[`fleet-implementer-alt.agent.md`](../../plugin/agents/fleet-implementer-alt.agent.md)
— see [Tier routing](tier-routing.md) for why.

## How it works

Phase 2 dispatches one implementer per Pull, never batched: the
controller records `ledger.mjs dispatch <N> impl-<N>` before the `task`
call, then dispatches in the background under the name `impl-<N>`, a
brand-new agent — never a resumed one, which would drag the previous
ticket's context into this one. The dispatch prompt carries only what
varies per ticket — the worktree's absolute path, branch,
`<scratch>/impl-<N>/`, and the ticket's distilled brief (title plus `##
Agent Brief` or body, and `Out of scope`) — because the shared
unattended-member rules (absolute-path edit/read discipline, re-deriving
against `origin/main`, committing incrementally rather than stashing, one
shared eval kernel namespaced per member, sizing via the
[`sizing-a-ticket`](sizing-a-ticket.md) skill) live once in the agent
definition and load automatically. The implementer's own duties, in
order: verify it is already in the right worktree, re-derive ticket truth
from `origin/main` (never trust a drifted line number), invoke
`sizing-a-ticket` to pick a light or heavy path, implement with a
bug-class enumeration discipline (also enumerate the false-positive class
a fix must not touch), rebase onto `origin/main`, run the
[Recipe](recipe.md)'s test entrypoint, push, `gh pr create` with `Closes
#N`, then separately `gh pr edit --add-label <patch|minor|major>`, and
report the PR number, head SHA, and whether `sizing-a-ticket` picked
light or heavy. `~/.fleet/bin/fleet-run tier-check.mjs --batch <path>`
runs after every Pull's dispatch and compares what the harness actually
resolved against the agent file's declared tier; a mismatch holds the
next Pull until a corrected redispatch clears it.

## Opinionated choices

Fresh context, always: an implementer that bails, stalls, or is killed is
replaced by a brand-new member under a new name on the same ticket, never
woken or resumed — resuming drags stale ticket state back in, and `hub
send` to an idle peer wakes it into its old transcript the same way a
re-dispatch under the same name would (omp auto-suffixes a fresh peer
instead). `-alt` exists to make the tier comparison unconfounded: it is
the identical prompt body, differing only in its declared `model:`, so
any measured difference in outcome is attributable to the tier alone
([ADR 0005](../adr/0005-tier-declared-per-harness-verified-at-dispatch.md)).
Every reported SHA is verified (`verify-sha.sh`) before it's trusted,
because a member can commit inside a nested worktree and report a SHA
that never actually landed where it claims.
