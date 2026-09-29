# Recipe

## What it is for

The pair of commands the fleet needs to work in any consumer repo: an
**Install step** that materializes dependencies, and a **Test
entrypoint** that runs the repo's own suite. The target design derives
both by agent reasoning over the repo, never guessing from a hardcoded
table of technologies
([ADR 0015](../adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md));
today's shipped derivation is Node-only, keyed on a lockfile table (see
**Opinionated choices** below).

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
3. **Cache (planned, #2117/#2118).** Once landed, a proven Recipe will
   be written to a **Recipe cache** under `.fleet/`, carrying the
   commit it was derived at and the proof, with scripts reading it and
   only the proving agent writing it — a missing cache meaning
   "derive," never "infer." Not shipped today: every claim and review
   re-derives directly.

## Opinionated choices

- **Today's derivation is Node-only, keyed on a hard-coded lockfile
  table.** `claim-ticket.sh` and `derive-testcmd.sh` branch on
  `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock` and a manifest
  `scripts.test`/test-file regex; the "no technology table" design
  above is the planned successor once #2117/#2118 land, not the
  current mechanism
  ([ADR 0015](../adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md)).
- **The vacuity guard is a hard refusal, not a warning.** `node --test`
  with no test files exits 0, and a runner that passes vacuously is
  worse than one that is visibly dead — every consumer downstream reads
  silence as a green suite, so a fleet that ran tests-that-never-run at
  scale would never notice.
