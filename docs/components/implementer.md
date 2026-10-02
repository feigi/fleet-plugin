# Implementer

## What it is for

The implementer turns one claimed ticket into a pushed branch and an
open PR. It runs as `fleet-implementer-<cell>.agent.md`: one definition
per cell (`slow-high`, `slow-medium`, `task-high`, `task-max`,
`smol-high` — an omp role and a thinking level), byte-identical bodies,
each declaring the route its name derives. A row with no `tier=` runs
at the policy cell,
[`fleet-implementer-slow-high.agent.md`](../../plugin/agents/fleet-implementer-slow-high.agent.md);
every 5th Pull by ledger count runs at an exploration cell — see
[Tier routing](tier-routing.md) for why.

## How it works
1. **Dispatch.** One implementer per Pull, never batched: the
   controller records `ledger.mjs dispatch <N> impl-<N>`, then
   dispatches in the background under the name `impl-<N>` — a
   brand-new agent, never resumed.
2. **Prompt carries only what varies**: the worktree's absolute path,
   branch, `<scratch>/impl-<N>/`, and the ticket's distilled brief.
   Shared rules (absolute-path discipline, re-deriving against
   `origin/main`, incremental commits, one shared eval kernel) live once
   in the agent definition and load automatically.
3. **Duties, in order:** verify it's in the right worktree, re-derive
   ticket truth from `origin/main`, invoke
   [`sizing-a-ticket`](sizing-a-ticket.md) for a light or heavy path,
   implement with a bug-class enumeration discipline, rebase, run the
   [Recipe](recipe.md)'s test entrypoint, push, `gh pr create` with
   `Closes #N`, then separately `gh pr edit --add-label
   <patch|minor|major>`.
4. **Report** the PR number, head SHA, and whether sizing picked light
   or heavy.
5. **Verify.** `tier-check.mjs --batch <path>` runs after every Pull's
   dispatch and compares the harness's actual resolution against the
   declared tier; a mismatch holds the next Pull until a corrected
   redispatch clears it.

## Opinionated choices

- **Fresh context, always.** An implementer that bails, stalls, or is
  killed is replaced by a brand-new member under a new name on the same
  ticket, never woken or resumed — resuming drags stale ticket state
  back in.
- **`-alt` makes the tier comparison unconfounded.** It is the identical
  prompt body, differing only in its declared `model:`, so any measured
  difference in outcome is attributable to the tier alone
  ([ADR 0005](../adr/0005-tier-declared-per-harness-verified-at-dispatch.md)).
- **Every reported SHA is verified** (`verify-sha.sh`) before it's
  trusted, because a member can commit inside a nested worktree and
  report a SHA that never actually landed where it claims.
