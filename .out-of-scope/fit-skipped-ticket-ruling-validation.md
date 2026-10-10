# Ruling Validation For Fit-Skipped Tickets

`fit`, `fit --check` and `fitTickets` in `ticket-router.mjs` skip a ticket that is not in the fit's A/B set before reading its ruling, so a malformed `run_date` on such a ticket is not refused there. Proposals to validate the ruling of every ticket inside `fitTickets` are refused.

## Why this is out of scope

The skipped ticket's ruling never reaches the estimates, so the fit's output is not wrong. The malformed ruling is refused elsewhere: `pr-cost.mjs --guard` calls `rulingFor` for every ticket with a features row in the window, with no exploration or rule skip, so over the same corpus it covers a superset of the fit's tickets. The window is the fit's own while `WINDOW_START` in `pr-cost.mjs` is unchanged, because the fit takes `guard.window_start` from the guard file `pr-cost` writes. `--check` re-fits with the table's recorded `window_start` while `pr-cost` always uses the constant, so once an edit moves the constant forward, a ticket whose features rows all predate the new window is no longer covered. `rulingFor` throws on a ruling whose `run_date` is not `YYYY-MM-DD`.

Adding the check to `fitTickets` would be a second copy of a validation that already runs earlier, and #2770 (recorded by #3009) already ruled that "input ticket" means the fit's A/B set.

The backstop is not universal, and for the local hook it is not the guard. The guard and the fit read the same corpus only when both are pointed at the same TSVs. The only caller that fails on `pr-cost --guard`'s exit 2 is the local run-team hook (`.omp/skills/run-team-local/hook.mjs`), which is repo-local workflow, not the shipped `plugin/`. It runs the guard against the working tree's `docs/metrics/` TSVs but fits from `origin/main`'s TSVs in a throwaway worktree, so a malformed ruling that is on `origin/main` and absent from the local checkout is not read by that guard. What refuses a committed malformed ruling is CI's `Tier-outcomes check` (`tier-outcomes.mjs check` over `docs/metrics/tier-outcomes.tsv`), which fails on any row whose `run_date` is not `YYYY-MM-DD`, with no window or tier skip. `fleet-tick.mjs` treats a missing guard file as default-only, not an error. The appender always writes today's date, so a bad `run_date` can only come from a hand edit.

## What reopens it

A malformed ruling that reaches a fit without passing either `pr-cost --guard` or CI's `Tier-outcomes check` — a shipped consumer of the fit that does not run the guard first and reads a `tier-outcomes.tsv` CI has not checked, or a ruling producer other than the appender.

## Prior requests

- #3012 — "fit and --check accept a malformed ruling of a ticket fitTickets skips that fit --due refuses, then silences it once the fit advances"
