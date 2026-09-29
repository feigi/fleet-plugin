# Isolation

## What it is for

Keeping every dispatched member's work — and every specialist's
deliberately mutated tree — from colliding with a sibling's, with the
controller's own main checkout, or with the repository's shared ref
store.

## How it works
1. **Filesystem isolation is stack isolation.** A private worktree copy
   doesn't by itself isolate runtime resources sharing it, so
   [`claim-ticket.sh`](../../plugin/scripts/claim-ticket.sh) derives
   fixed ports (`postgres = 16000 + issue`, `ollama = 22000 + issue`)
   from the ticket number, and `./agent-test` exports one
   `TEST_COMPOSE_PROJECT` name per worktree so N concurrent Compose
   stacks don't collide.
2. **Scratchpad paths need two levels.** An implementer owns
   `<scratch>/impl-<N>/`, a review-side member owns
   `<scratch>/pr<N>/...`, and every child a member dispatches
   partitions further under that (`<scratch>/pr<N>/fix-XXXXXXXX/`) —
   never the shared scratch root directly, never shared with a sibling.
3. **Read-only vs. mutating stay physically separate.** A specialist's
   own `.agent.md` declares no write tools, so it can never share a
   copy with a mutating refuter even by accident; a refuter gets its
   own throwaway `git worktree add --detach` copy, mutated and
   discarded.
4. **The main checkout is enforced by prompt and by harness.** No
   per-call `cwd` exists in eval's `agent()`, so every specialist/
   refuter prompt names the inherited cwd a no-run zone and requires a
   `CWD-AUDIT:` line back; an omp `tool_call` extension backstops this
   independently, blocking a member's write into a main checkout it
   did not claim.

## Opinionated choices

- **Never `isolated: true` on a fleet member.** On omp that flag builds
  a workspace outside the claimed worktree and patch-applies changes
  back into the controller's own checkout on completion — the exact
  spill hazard the claim/release model exists to prevent.
- **The write-guard backstop exists because prompt discipline alone
  isn't enough for an unattended fleet.** A member briefed correctly
  can still be wrong under pressure, so isolation is enforced once in
  the prompt and once again, independently, by the harness.
