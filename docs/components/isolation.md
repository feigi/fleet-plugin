# Isolation

## What it is for

Keeping every dispatched member's work — and every specialist's
deliberately mutated tree — from colliding with a sibling's, with the
controller's own main checkout, or with the repository's shared ref
store.

## How it works

Filesystem isolation is stack isolation: a private worktree copy does
not by itself isolate runtime resources sharing that worktree, so
[`claim-ticket.sh`](../../plugin/scripts/claim-ticket.sh) also derives
fixed ports (`postgres = 16000 + issue`, `ollama = 22000 + issue`) from
the ticket number, and `./agent-test` — a bootstrap-materialized runner,
re-materialized fresh on every invocation rather than trusted stale —
exports one `TEST_COMPOSE_PROJECT` name per worktree so N concurrent
Docker Compose stacks don't collide. Scratchpad paths need two levels: an
implementer owns `<scratch>/impl-<N>/`, a review-side member owns
`<scratch>/pr<N>/...`, and every child a member dispatches partitions
further under that (`<scratch>/pr<N>/fix-XXXXXXXX/`) — never the shared
scratch root directly, and never shared with a sibling. A specialist
reads its snapshot with no write tools declared in its own `.agent.md`
frontmatter (`spawns:`/`tools:` restricted), so a mutating specialist and
a read-only one can never share a copy even by accident; a mutating
refuter gets its own throwaway `git worktree add --detach` copy, mutated
and discarded, never the pristine snapshot. Across the whole repo, every
fleet member writes through the maintainer's own `gh`/git credentials
into the main checkout only via its own worktree — no per-call `cwd`
exists in eval's `agent()`, so isolation is enforced in the dispatch
prompt: every specialist and refuter prompt names the inherited cwd a
no-run zone, orders a `cd` before any mutation, and requires a
`CWD-AUDIT:` line back. An omp `tool_call` extension backstops this at
the harness level, blocking a member's write into the main checkout it
did not claim, independent of whether the prompt discipline held.

## Opinionated choices

Never `isolated: true` on a fleet member: on omp that flag builds a
workspace outside the claimed worktree and patch-applies changes back
into the controller's own checkout on completion — precisely the spill
hazard the claim/release model exists to prevent, so it is banned
outright rather than configured carefully. The write-guard backstop
exists because prompt discipline alone was judged insufficient for an
unattended fleet: a member briefed correctly can still be wrong under
pressure, so isolation is enforced once in the prompt and once again,
independently, by the harness itself.
