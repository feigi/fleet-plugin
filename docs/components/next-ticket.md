# next-ticket (skill)

## What it is for

The human-present alternative to the fleet loop: pick, size, and claim
exactly one ticket for a maintainer asking "what's next," then hand off
to review and merge later, out of session.

## How it works
1. **List candidates** the same way the fleet does —
   `candidates.mjs --require-label ready-for-agent`, oldest first —
   plus `--allow-fallback` (solo-only): re-run unfiltered over
   `ready-for-human`/untriaged work when the primary query is empty,
   since a solo session has a human to ask.
2. **Filter.** Drop any candidate with an open dependency; run
   `inflight.sh` on each survivor.
3. **Suggest and wait.** Present three to five survivors oldest-first
   and wait for the maintainer's answer — the one hard synchronous gate
   in the flow; nothing here claims unilaterally.
4. **Claim** exactly the way [Pull & Claim](pull-and-claim.md) does —
   `in-progress` label, branch, worktree, install, baseline tests.
5. **Size** via [`sizing-a-ticket`](sizing-a-ticket.md) to decide how
   much process the ticket needs.
6. **Implement, rebase, open the PR** with `Closes #N`. The session
   ends there: it never merges, adds `ready-to-merge`, or waits on CI —
   that's `/fleet-ctl:review-and-fix` and `/fleet-ctl:run-merge-bot`'s
   job, invoked later, outside this session.

## Opinionated choices

- **No hand-rolled shortcuts.** Inlining a `gh` query instead of
  calling `candidates.mjs` was measured to drift from the real filter
  (missed to-spec drop, wrong sort order), so this skill reuses exactly
  the same admission scripts as the fleet loop.
- **Maintainer approval is a hard gate even with one candidate.** "I'll
  just start" is a named red flag — the difference between this skill
  and [Pull & Claim](pull-and-claim.md) is precisely that a human, not
  an automatic bar, makes the admission call.
