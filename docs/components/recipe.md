# Recipe

## What it is for

The pair of commands the fleet needs to work in any consumer repo: an
**Install step** that materializes dependencies, and a **Test
entrypoint** that runs the repo's own suite. Both are derived by agent
reasoning over the repo, never guessed from a hardcoded table of
technologies
([ADR 0015](../adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md)).
The reading side has shipped (#2117); the deriving side is still open
(#2118).

## How it works
1. **Derive (planned, #2118).** An agent reasons over the repo to
   choose the Install step and the Test entrypoint.
2. **Prove (planned, #2118).** The Install step is usable only once it
   has run in a fresh worktree and left the tree clean; the Test
   entrypoint is usable only once it has actually run and shown to
   execute real tests — a non-zero test count, or a deliberate
   mutation turning red, is what "passed" means.
3. **Cache.** A proven Recipe lives in the **Recipe cache**,
   `<workspace>/.fleet/recipe.json` in the main checkout, carrying the
   commit it was derived at and the proof. Only the deriving agent
   writes it (#2118, still open); no script does.
4. **Read (shipped, #2117).**
   [`derive-testcmd.sh`](../../plugin/scripts/derive-testcmd.sh) is the
   one reader of the cache and infers nothing. It is reused (never
   reimplemented) by [`claim-ticket.sh`](../../plugin/scripts/claim-ticket.sh)
   and by the review Snapshot (see [Reviewer](reviewer.md)). A missing
   or unproven cache is a refusal naming the step that derives one,
   never a guess.

## Opinionated choices

- **No technology table.** fleet-ctl keeps no map from lockfiles or
  manifests to commands; whatever a repo needs is the deriving agent's
  finding, recorded in the cache
  ([ADR 0015](../adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md)).
- **The vacuity guard is a hard refusal, not a warning.** `node --test`
  with no test files exits 0, and a runner that passes vacuously is
  worse than one that is visibly dead — every consumer downstream reads
  silence as a green suite, so a fleet that ran tests-that-never-run at
  scale would never notice.
