# Recipe

## What it is for

The pair of commands the fleet needs to work in any consumer repo: an
**Install step** that materializes dependencies, and a **Test
entrypoint** that runs the repo's own suite. Derived by agent reasoning
over the repo, never guessed from a hardcoded table of technologies
([ADR 0015](../adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md)).

## How it works
1. **Derive.** [`derive-testcmd.sh`](../../plugin/scripts/derive-testcmd.sh)
   is the one place the test-entrypoint inference lives, reused (never
   reimplemented) by [`claim-ticket.sh`](../../plugin/scripts/claim-ticket.sh)
   (at `origin/main`) and by the review Snapshot (see
   [Reviewer](reviewer.md), at HEAD). It prefers a manifest test script,
   falls back to a direct test-file run, and refuses rather than emit a
   command that could pass vacuously.
2. **Prove.** The Install step is usable only once it has left every
   tracked file unchanged; the Test entrypoint is usable only once it
   has actually run and shown to execute real tests — a non-zero test
   count, or a deliberate mutation turning red, is what "passed" means.
3. **Cache.** A proven Recipe is written to the **Recipe cache** under
   `.fleet/`, carrying the commit it was derived at and the proof.
   Scripts read it; only the agent that proved it writes it. A missing
   cache means "derive," never "infer."

## Opinionated choices

- **No table of supported technologies exists anywhere in this repo.**
  `claim-ticket.sh` and `derive-testcmd.sh` carry no lockfile regex, no
  per-language branch — a consumer repo's Recipe is derived "the way a
  new engineer would," not matched against a maintained inventory that
  inevitably lags what repos actually use
  ([ADR 0015](../adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md)).
- **The vacuity guard is a hard refusal, not a warning.** `node --test`
  with no test files exits 0, and a runner that passes vacuously is
  worse than one that is visibly dead — every consumer downstream reads
  silence as a green suite, so a fleet that ran tests-that-never-run at
  scale would never notice.
