# next-ticket (skill)

## What it is for

The human-present alternative to the fleet loop: pick, size, and claim
exactly one ticket for a maintainer who is sitting at the session asking
"what's next," then hand off to review and merge later, out of session.

## How it works

[`plugin/skills/next-ticket/SKILL.md`](../../plugin/skills/next-ticket/SKILL.md)
runs seven steps. It lists candidates the same way the fleet does —
`candidates.mjs --require-label ready-for-agent`, oldest first — but adds
`--allow-fallback`, a solo-only flag that re-runs unfiltered over
`ready-for-human`/untriaged work when the primary query comes back
empty, because a solo session has a human to ask and an unattended fleet
does not. It drops any candidate with an open dependency, runs
`inflight.sh` on each survivor, then **suggests three to five candidates
and waits for the maintainer's answer** — the one hard synchronous gate
in the whole flow; nothing here claims unilaterally, because labels and
git state only record *some* claims, and others live only in a
maintainer's head or another agent's session. Once the maintainer picks,
it claims exactly the way [Pull & Claim](pull-and-claim.md) does —
`in-progress` label, branch, worktree, install, baseline tests — invokes
[`sizing-a-ticket`](sizing-a-ticket.md) to decide how much process the
ticket needs, implements, rebases onto `origin/main`, and opens a PR
with `Closes #N`. The session ends there: it never merges, never adds
`ready-to-merge`, and never waits on CI — that's `/fleet-ctl:review-and-fix`
and `/fleet-ctl:run-merge-bot`'s job, invoked later, outside this
session.

## Opinionated choices

The solo path deliberately duplicates none of the fleet's own scripts by
hand — inlining a `gh` query instead of calling `candidates.mjs` was
measured to drift from the real filter (missed to-spec drop, wrong sort
order), so this skill reuses exactly the same admission scripts as the
fleet loop rather than a hand-rolled shortcut. Maintainer approval is a
hard gate even when only one candidate survives — "I'll just start" is a
named red flag here, because the difference between this skill and the
fleet's own [Pull & Claim](pull-and-claim.md) is precisely that a human,
not an automatic bar, makes the admission call.
