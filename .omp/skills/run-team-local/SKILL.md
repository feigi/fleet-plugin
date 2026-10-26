---
name: run-team-local
description: fleet-plugin's own self-maintenance duties after a /fleet-ctl:run-team run on this repository — role-target drift notice, per-cell stopping rule, router re-fit. Not called by run-team; this repo's AGENTS.md triggers it, or the operator runs it by hand.
disable-model-invocation: true
---

# run-team-local

fleet-plugin dogfoods its own plugin, so the duties that only maintain the
plugin live here, not in the plugin it ships. `/fleet-ctl:run-team` never calls
this skill: the repository's `AGENTS.md` rule runs it after a run, and the
operator running it by hand is the fallback. Usage metrics — the member-outcomes
scrape, the tier-outcomes appends, the ticket-features drain and the cost
guard — are the plugin's own and are not repeated here.

Run it from the main checkout, once, after a run has finished and its metrics
PR is open or merged:

```bash
node .omp/skills/run-team-local/hook.mjs
```

Every duty is `hook.mjs`, beside this file, and every duty is safe to run
again, so a missed run strands nothing: the next one catches up. The stopping
rule reads this checkout's `docs/metrics/` files, so it judges the corpus as
the run left it; the re-fit reads the corpus committed on `origin/main`, so it
judges what earlier runs' merged metrics PRs landed, not the working tree.

## Duties

In this order:

1. **Role-target drift notice:** each `fleet-implementer-<cell>` definition's
   most recent admissible `member-outcomes.tsv` row's `model` against
   `modelRoles.<role>`'s current target, and the cell's level against the
   levels that target runs at. A `tier-roles: notice:` line is reported,
   never acted on — rows pool across resolved models (spec § 2).
   `tier-roles.mjs` only supplies the target and stays blind to the metrics.
2. **Per-cell stopping rule** (`cell-readout.mjs`'s `stoppingRule`): a cell
   whose newest generation (its latest admissible Pull's generation, the
   `dispatch_model` of that Pull's first Admissible implementer row) has
   at least 10 verdicts since its definition was last added, and floor
   failures on at least 80% of them, gets one `ready-for-human` issue titled
   `Withdraw exploration cell <cell>: <failures>/<verdicts> floor failures on <generation>`,
   its body the verdict table. An older generation's tally is printed on its
   own line and never withdraws the cell. One open issue per cell: an open issue whose
   title starts with `Withdraw exploration cell <cell>:` (case aside) is that
   cell's — left as it is when its title is the new one, otherwise commented
   with the new verdict table and retitled to the new tally and generation. Where several are
   open, the one already at the new title is kept, else the lowest-numbered is
   retitled, and the rest are named in the duty's output and left as they are.
   Withdrawing the cell is the maintainer's PR, not yours.
   A definition no commit adds (a shallow clone, an uncommitted or renamed
   file) cannot be judged: the duty reports the cells it could judge, then
   fails naming the definition, so the router re-fit does not run.
3. **Router re-fit:** once 50 merged PRs have features rows that are not in
   `router-table.json`'s `fitted_commit`, `ticket-router.mjs fit` runs in a
   throwaway checkout of `origin/main` and reads the committed corpus at
   that commit — CI's `ticket-router.mjs --check` re-fits from the commit the
   table records — and the new table goes out
   as a chore PR from `chore/router-fit-<date>`, labelled `patch`. Skipped
   while an earlier `chore/router-fit-*` PR is still open. The fit reads
   `.fleet/cost-guard.json`, which the run's own close-out leaves; where it is
   missing (a fresh checkout), run `node plugin/scripts/metrics-refresh.mjs`
   first. **Never add `ready-to-merge` to the re-fit PR and never merge it
   yourself:** it is not the run's data-only metrics PR, and it closes no
   issue, so it waits for the next run's phase 0, which folds it in as a
   Ticketless PR, reviews it, and stops it for a human, because
   `router-table.json` is not an Inert diff.

## Reading it

One `run-team-local: <duty>: …` line per duty on stdout, plus any
`tier-roles: notice:` lines. Exit 0: every duty ran. Exit 1: the duty named on
stderr failed and the ones after it did not run — fix the cause and run it
again. Exit 2: a usage error.

`--dry-run` writes nothing to GitHub and pushes nothing — the withdrawal issue
and the re-fit PR print as `would …` — while every local duty still runs.
`--repo`, `--agents`, `--model-roles` and `--catalog` point the hook at a
fixture instead of this checkout and the live omp config; `hook.mjs`'s header
says what each one defaults to.
