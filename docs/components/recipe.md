# Recipe

## What it is for

The pair of commands the fleet needs to work in any consumer repo: an
**Install step** that materializes dependencies, and a **Test
entrypoint** that runs the repo's own suite. The Recipe is derived by
agent reasoning over the repo — its README, build files, CI workflow —
never guessed from a hardcoded table of technologies
([ADR 0015](../adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md)).

## How it works

[`derive-testcmd.sh`](../../plugin/scripts/derive-testcmd.sh) is the one
place the test-entrypoint inference lives, reused rather than
reimplemented by [`claim-ticket.sh`](../../plugin/scripts/claim-ticket.sh)
(worktree setup, at `origin/main`) and by the review Snapshot (see
[Reviewer](reviewer.md), at the reviewed commit's HEAD): it prefers a
manifest test script, falls back to a direct test-file run, and
*refuses* rather than emit a command that could pass vacuously — `node
--test` with no test files exits 0, and a runner that passes vacuously is
worse than one that is visibly dead, because every consumer downstream
reads silence as a green suite. The Install step is usable only once it
has left every tracked file unchanged; the Test entrypoint is usable only
once it has actually been run and shown to execute real tests — a
non-zero test count, or a deliberate mutation turning red, is what
"passed" means, never an unexamined `exit 0`. A proven Recipe is written
to the **Recipe cache** under `.fleet/`, carrying the commit it was
derived at and the proof; scripts read it, only the agent that proved it
writes it, and a missing cache means "derive," never "infer" — absent is
a silent guess this repo refuses to make.

## Opinionated choices

No table of supported technologies exists anywhere in this repo, on
purpose: `claim-ticket.sh` and `derive-testcmd.sh` carry no lockfile
regex, no per-language branch, no runnable-code extension list — a
consumer repo's Recipe is derived "the way a new engineer would," by
reading the repo itself, not matched against a maintained inventory that
inevitably lags what repos actually use
([ADR 0015](../adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md)).
The vacuity guard is a hard refusal, not a warning: an install or test
command that would pass trivially is treated as a defect in the
derivation, not a fact about the repo, because a fleet that ran
tests-that-never-run at scale would never notice.
