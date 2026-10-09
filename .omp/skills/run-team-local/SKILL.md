---
name: run-team-local
description: fleet-plugin's own run-team hook — the metrics duties this repository has at phase 0 and close-out of a /fleet-ctl:run-team run. Called by name at those two points, never by description match.
disable-model-invocation: true
---

# run-team-local

fleet-plugin dogfoods its own plugin, so the run conventions that only make
sense on this repository live here, not in the plugin it ships (#2089; duties
from `docs/specs/2026-09-28-model-effort-router-design.md` § 5). The
`/fleet-ctl:run-team` controller is to call this by name at two fixed points;
that call is #2089's, so until it lands the fleet's operator runs it by hand at
those points. Every duty is `hook.mjs`, beside this file; run it from the main
checkout:

```bash
node .omp/skills/run-team-local/hook.mjs phase-0
node .omp/skills/run-team-local/hook.mjs close-out
```

## Phase 0

After the fast-forward and the instrument pin, before the first Pull is
routed — the router reads `.fleet/cost-guard.json`, so the guard has to be
fresh before it does.

1. **Drain** `.fleet/ticket-features.pending.tsv` into
   `docs/metrics/ticket-features.tsv`, deduped on `session`+`agent`: this
   recovers the rows of a run that crashed before its close-out.
2. **Cost guard:** `pr-cost.mjs --guard` rewrites `.fleet/cost-guard.json`.
   Its exit 3 (a cell tripped) and 4 (no verdict yet) are verdicts the router
   and `fleet-tick.mjs` read, not failures.
3. **Role-target drift notice:** each `fleet-implementer-<cell>` definition's
   most recent admissible `member-outcomes.tsv` row's `model` against
   `modelRoles.<role>`'s current target, and the cell's level against the
   levels that target runs at. A `tier-roles: notice:` line is reported,
   never acted on — rows pool across resolved models (spec § 2).
   `tier-roles.mjs` only supplies the target and stays blind to the metrics.

## Close-out

After the member-outcomes scrape and every `tier-outcomes.mjs append`, before
the run's artifacts are committed:

1. **Drain** again, so this run's own rows are in the file that gets committed.
2. **Cost guard** again.
3. **Per-cell stopping rule** (`cell-readout.mjs`'s `stoppingRule`): a cell
   with at least 10 verdicts since its definition was last added, and floor
   failures on at least 80% of them, gets one `ready-for-human` issue titled
   `Withdraw exploration cell <cell>: <failures>/<verdicts> floor failures`,
   its body the verdict table. One open issue per cell: an open issue whose
   title starts with `Withdraw exploration cell <cell>:` (case aside) is that
   cell's — left as it is when its title is the new one, otherwise commented
   with the new verdict table and retitled to the new tally. Where several are
   open, the one already at the new tally is kept, else the lowest-numbered is
   retitled, and the rest are named in the duty's output and left as they are.
   Withdrawing the cell is the maintainer's PR, not yours.
   A definition no commit adds (a shallow clone, an uncommitted or renamed
   file) cannot be judged: the duty reports the cells it could judge, then
   fails naming the definition, so the router re-fit does not run.
4. **Router re-fit:** once 50 PRs have merged since `router-table.json`'s
   `fitted_through`, `ticket-router.mjs fit` runs in a throwaway checkout of
   `origin/main` — against the committed corpus, because CI's
   `ticket-router.mjs --check` re-fits from that — and the new table goes out
   as a chore PR from `chore/router-fit-<date>`, labelled `patch`. Skipped
   while an earlier `chore/router-fit-*` PR is still open. **Never add
   `ready-to-merge` to it and never merge it yourself:** it is not the run's
   data-only artifacts PR, and it closes no issue, so it waits for the next
   run's phase 0 to fold it into that run's review queue.

Once drained, `docs/metrics/ticket-features.tsv` is a run artifact: commit it
to `chore/run-artifacts-<date>` beside the two `docs/metrics/` files that PR
already carries.

## Reading it

One `run-team-local: <duty>: …` line per duty on stdout, plus any
`tier-roles: notice:` lines. Exit 0: every duty ran. Exit 1: the duty named on
stderr failed and the ones after it did not run — fix the cause and run the
same phase again; every duty is safe to repeat. Exit 2: a usage error.

`--dry-run` writes nothing to GitHub and pushes nothing — the withdrawal issue
and the re-fit PR print as `would …` — while every local duty still runs.
`--repo`, `--agents`, `--model-roles` and `--catalog` point the hook at a
fixture instead of this checkout and the live omp config; `hook.mjs`'s header
says what each one defaults to.
