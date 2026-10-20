# Recipe

## What it is for

The set of commands the fleet needs to work in any consumer repo: an
**Install step** that materializes dependencies, a **Check step** that runs the
merge-gating CI checks that are not tests, and a **Test
entrypoint** that covers every test step in the merge-gating CI jobs that
can run in a fresh worktree without a running service — anything a command
needs that it does not start as its own child process, such as a Docker
daemon, a database or other server installed on the host, a host daemon, or
secrets in the environment. Neither the Test entrypoint nor the Check step
ever needs one, including one the command starts itself, whether or not it is
up while the Recipe is derived: a step that needs one is listed in
`uncovered`, and a repository with no service-free test step is `RECIPE NOT
PROVEN`. All three are derived by agent
reasoning over the repo, never guessed from a hardcoded table of
technologies
([ADR 0015](../adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md)).
The reading side shipped with #2117 and the deriving side with #2118.

## How it works
1. **Derive.** The
   [`fleet-recipe-deriver`](../../plugin/agents/fleet-recipe-deriver.agent.md)
   agent reads the repo (README, build files, CI workflow) and chooses the
   Install step, the Check step and the Test entrypoint. The run-team
   controller dispatches it in phase 0 when the cache is missing or invalid;
   a standalone `next-ticket` or `review-and-fix` session dispatches it the
   same way.
2. **Prove.** [`recipe-prove.mjs`](../../plugin/scripts/recipe-prove.mjs)
   checks the shape of every command before it creates a worktree or runs
   anything: each of the Install step, the Check step and the Test entrypoint
   must pass the reader's `--propose` check (found and executable, and no
   refused form). The Test entrypoint must be one simple command: an unquoted
   newline, `;`, `&&`, `||`, `|`, a `&` outside a redirection, or a `( … )`
   group is refused, because a runner-appended argument would land after the
   last one and never reach the Test entrypoint. A directory option (`npm --prefix web
   test`) or `sh -c 'cd web && npm test -- "$@"' sh` is the accepted form.
   The prover requires `--covered <json>`, the ledger of merge-gating CI steps
   the Test entrypoint or the Check step covers. The ledger is validated for
   shape and is never cached. Then it runs all three commands in a throwaway
   worktree of `origin/main`. The Install
   step must leave the tree clean; the Check step must run green and a deliberate
   mutation must turn it red, unless the repository has no such step; the Test
   entrypoint must be shown to execute real tests — the runner's own non-zero
   count, or a deliberate mutation turning the run red.
3. **Cache.** A proven Recipe lives in the **Recipe cache**,
   `<workspace>/.fleet/recipe.json` in the main checkout, carrying the
   commit it was derived at, the proof, the Check step, and `uncovered` — the
   merge-gating CI steps neither the Test entrypoint nor the Check step runs, each with its reason, `[]` for
   none. `recipe-prove.mjs` is its only writer, and writes only once the
   proof holds.
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
