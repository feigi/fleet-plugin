# 0034 — The fleet owns the PRs its login authored; a Ticketless PR merges unattended only on an Inert diff

**Status:** Accepted. Ruled 2026-10-25 on #3748 by the maintainer, in a grilling session over three rounds, against anchors measured on origin/main `41f96f6c`. Sequenced after #3747, whose Inert diff verdict it consumes.

## Context

Phase 0's fold-in wrote a ledger row for every open PR that closes an issue in its own repository, whoever opened it and whether or not it was a draft. For a PR that closes none it only printed `NEED review PR#<n> (closes no issue)`. The tick replayed that line as `PHASE0-ADVICE` on every pass and nothing acted on it: `reviewDue` required a closing reference, so a PR closing nothing was never queued. A controller-authored chore or docs PR therefore needed a hand-dispatched review, fix-applier, finisher and release label. The ticket counts 183 PRs since 2026-08-01 that closed no issue, about 17 a week lately; this record does not re-derive its measurements.

Queueing alone is unsafe. With no settled `impl-<N>=PR#<pr>` token, `rulingOf` asks for no ruling, so a labelled PR that no ticket stands behind would merge with no human, whatever it changes. And duty 2's acceptance mutation is the ticket's own: a PR with no ticket has none to re-run, and the ticket records improvised mutations halting with cause `other` on #3754 and #3764.

The same missing rule let a stranger's, a fork's or a draft issue-closing PR be folded in and reviewed today.

## Decision

1. **An Owned PR is an open, non-draft PR whose `author.login` is the login the fleet's `gh` credentials answer to** (`gh api user -q .login`). Every member acts through the maintainer's `gh` credentials, so every PR the fleet opens is authored by that login. The maintainer's own non-draft PRs are owned too, by design; Renovate's and Dependabot's are not, because their authors are bots. Opening a PR as a draft keeps the fleet off it. The ticket measured every PR since 2026-08-01 as the maintainer's, with no fork and one draft.
2. **The rule is exported once**, as `isOwnedPr` in `owned-pr.mjs`, and phase 0's fold-in and the tick both import it. It gates issue-closing PRs too.
3. **Each reader reads the login itself**, at its own read: fold-in once per step, and the tick once per pass. No receipt field carries it, so no reader trusts a login another read made. **A failed or empty read refuses**, like the `gh pr list` beside it: fold-in fails its step (phase 0 exit 3) and the tick exits 2. It is never read as "owns nothing", which would fold nothing in and say `ok`.
4. **Fold-in writes a row for every Owned PR no carried row names**: `PR#<n> · inherited (closes #…)` for an issue-closing one, `PR#<n> · inherited (closes no issue)` for a Ticketless one. A PR that is not owned gets no row and no line. The `NEED review` advice and everything that carried it are gone.
5. **The tick queues an Owned PR for review** whether or not it closes an issue: `reviewDue` is not queued, owned, and either no review on record or a `past-pin` halt. `ledger.mjs review` creates the row on first use. The In-flight count, the run-over check, the end-of-run check and the Pull are unchanged: a PR closing nothing is still never In flight, and any open PR, owned or not, still holds a draining run open.
6. **A Ticketless PR is an open PR that closes no issue in its own repository and that no settled `impl-<N>=PR#<pr>` token names.** `ticketless.mjs` is the one test for it, with a CLI (exit 0 ticketless, 1 not, 2 could not look); `ledger.mjs`'s release-label gate, `finisher-label.mjs` and finisher duty 2 all use it and none keeps a copy.
7. **A Ticketless PR merges unattended only on an Inert diff, and otherwise halts `human`, because no ticket gives it a ruling or a mutation.**
   - Duty 2 skips the acceptance mutation on the Ticketless test's exit 0 alone, whatever the diff; the rest of duty 2 runs. On exit 1 or 2 it runs as before.
   - Duty 3, `finisher-label.mjs`, adds `patch` to a Ticketless PR that carries no release label (the dispatch gate no longer refuses it), then runs the Inert diff verdict in-process at the pin. Inert: the ordinary steps. Not inert, or a verdict that could not look: it posts the `ready-to-merge-head:` record, adds no `ready-to-merge`, and exits 5. The finisher reports halt cause `human`; the maintainer adds `ready-to-merge` at the pinned head and the merge bot merges it off the record. A head that moved after the record is merged by hand.
   - `human` is appended to `HALT_CAUSES`; its resolution is escalation with no automatic retry.
8. **Rejected ownership markers**, each for what it would have admitted or lost:
   - *Any non-bot author* admits strangers' PRs and fork PRs on a public consumer repository.
   - *A label* depends on the Label map, which is unbuilt, and openers forget labels: the ticket names #3751 and #3754, both opened without their release label.
   - *A branch prefix*: the ticket records the no-issue PRs using 15 prefixes, and `docs/*` branches carrying code.
   - *A ledger line* dies with the run, and an inherited PR has none.

## Consequences

- A controller-authored chore or docs PR is reviewed, fixed, finished and, on an Inert diff, merged without a hand-dispatched member. A Ticketless PR that changes code stops at its finisher for a human.
- A PR the fleet did not author, and a draft, is invisible to fold-in and to the review queue. A maintainer who wants the fleet to review one opens it ready, from the maintainer's own login.
- Tier-outcomes takes no row for a Ticketless PR: there is no ticket to key one on.
- A repository with several maintainers sharing one `gh` login owns every PR any of them opens, as the fleet's own are indistinguishable from theirs by author.
- `finisher-label.mjs` now reads the Ticketless test before it counts labels, so a failed `gh` or ledger read there is exit 2 for a ticket PR too.
