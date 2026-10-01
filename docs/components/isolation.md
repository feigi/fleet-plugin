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
   per-call `cwd` exists in eval's `agent()`, so every
   specialist/refuter prompt names the inherited cwd a no-run zone and
   requires a `CWD-AUDIT:` line back. Behind that, an omp `tool_call`
   extension refuses the write (#1411,
   [`member-write-guard.mjs`](../../plugin/scripts/member-write-guard.mjs)),
   and [`main-checkout.mjs`](../../plugin/scripts/main-checkout.mjs)
   catches what it cannot see (#2210): Phase 0 records a baseline of the
   main checkout's porcelain entries and their content hashes, and every
   `fleet-tick.mjs` compares against it, holding all dispatch on
   `MAIN-CHECKOUT-DIRTY`/`-UNKNOWN` until the maintainer resolves the
   stray paths and re-baselines.

## Opinionated choices

- **Never `isolated: true` on a fleet member.** On omp that flag builds
  a workspace outside the claimed worktree and patch-applies changes
  back into the controller's own checkout on completion — the exact
  spill hazard the claim/release model exists to prevent.
- **The write-guard backstop exists because prompt discipline alone
  isn't enough for an unattended fleet.** A member briefed correctly
  can still be wrong under pressure, so isolation is enforced once in
  the prompt and again, independently, by the harness: #1411 prevents,
  #2210 detects.
- **Detection holds; it never reverts.** Concurrent members make a
  stray change impossible to attribute, and re-baselining overwrites
  rather than compares, so clearing the hold is the maintainer's call —
  never over an `unknown` the tick could not look past.
