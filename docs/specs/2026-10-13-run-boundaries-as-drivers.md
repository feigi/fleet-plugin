# Run boundaries as drivers: phase 0 and close-out are one command each, with a receipt the tick gates on

Date: 2026-10-13
Status: spec, input to `/to-tickets`. Spec 3 of 6 from the 2026-10-13 determinism review.
Relates to: `run-team/SKILL.md` § Phase 0 step 0 and § Phase 3 "End of run"; ADR 0025 (nothing restarts a dead run; the next run resumes it); #3127 (no script resolves the controller's own session directory); `AGENTS.md` § Runs on this repo (a stranded data row is lost).
Depends on: nothing. Spec 4 builds on the receipt pattern and the session directory this spec records.
Base tree: `main` at `bd4afac` (2026-10-13).

## Problem Statement

Phase 0 is fifteen ordered commands, stated in prose paragraphs of their own
(the `branch` check opens the fast-forward paragraph, and the `tier-roles`
check is stated in Phase 2, "before the run's first dispatch"): branch
check, fast-forward check, instrument pin, main-checkout baseline,
pre-flight, ruleset check, tier-roles check, metrics refresh, cockpit
launch, ledger rotate, scratch reclaim, recipe check or derivation,
fold-in of inherited PRs, stranded claims, shortlist. The order matters
(pin after the fast-forward, rotate before the fold-in, reclaim straight
after rotate, guard refresh before the first Pull). End of run is six
ordered steps, with `fleet-heartbeat.mjs --stop` last because every reader
takes it as the end.

Nothing checks that the sequence ran or ran in order. The tick's only start
gate is `MAIN-CHECKOUT-NO-BASELINE`, which proves one step of fifteen. The
effects are the ones the runbook itself records: a skipped fold-in strands a
prior run's PR unreviewed and uncounted; a skipped scrape loses the run's
member-outcomes rows for good, because the transcripts belong to the harness;
a skipped `--stop` makes the next run report a stall "without a recorded
reason"; a pin taken before the fast-forward certifies superseded text for
the whole run. The one place the runbook gates a duty on a receipt, the tier
check (`HOLD (tier unchecked impl-<N>)` until a verdict is on the row), is
the one duty nobody reports forgetting.

## Solution

`phase0.mjs` runs the start sequence in order and writes a receipt; `closeout.mjs`
runs the end sequence in order and writes a receipt. Each step's result is
recorded by name, each script is idempotent and resumable, and the two steps
that need a member (recipe derivation, stranded-claim resume) stop the script
with a named need and resume when it is met. `fleet-tick.mjs` holds every
dispatching row until this run's phase-0 receipt lists every step, the same
shape as the tier-unchecked hold.

## User Stories

- As the controller, I want to run `phase0.mjs` once and act on what it
  prints, so that fifteen commands and their order are not mine to
  remember.
- As the controller, I want the tick to print `PHASE0-INCOMPLETE recipe,
  stranded` and hold dispatch, so that a run I started half-way cannot pull
  a ticket.
- As the controller, I want `closeout.mjs --reason "<r>"` to refuse to
  record the stop while a reviewed PR has no tier-outcomes row, so that the
  metrics PR never ships with a hole the next run cannot fill.
- As a maintainer, I want the receipt archived with the ledger, so that a
  dead run's start and end are readable from the archive.
- As the tick and the tier check, I want the controller's session directory
  recorded once at phase 0, so that no script asks the controller to recall
  it (#3127).

## Implementation Decisions

**D1. `phase0.mjs`.** `~/.fleet/bin/fleet-run phase0.mjs --session <dir>
[--in-flight n] [--plugin-checkout <dir>] [--spend-dir <dir>]
[--workflow <name> | --declare-no-ci]`. `--session` names the controller's
session directory, else `PI_ARTIFACTS_DIR` supplies it (omp exports it to the
Python eval kernel, not to the bash tool), and with neither the script exits 2;
it is the one place the controller states its session directory, and the
receipt's resume rule (D2) compares against it. Steps, in this order, each a
named entry in the receipt:

| step | command | on failure |
|---|---|---|
| `branch` | `git symbolic-ref -q HEAD` is `refs/heads/main` | exit 3, stop |
| `fast-forward` | fetch, `rev-list --count main..origin/main`, `merge --ff-only` | moved HEAD → print `SUPERSEDED <n> commits; re-run phase0.mjs`, exit 3; the re-run executes from the new tree |
| `pin` | `instruments.sh --pin [--audit <plugin-checkout>]` | exit 3, stop |
| `baseline` | `main-checkout.mjs --record` | DIRTY/UNKNOWN refusals as today, exit 3 |
| `preflight` | `preflight.mjs` | exit 1 or 2 → exit 3 with every FAIL line |
| `ruleset` | `.github/scripts/apply-ruleset.sh --check` when the spec exists | 3 or 2 → recorded as `drift`/`unanswered`, continue |
| `tier-roles` | `tier-roles.mjs --check` | exit 3, stop |
| `metrics` | `metrics-refresh.mjs` | exit 1 or 2 → exit 3 |
| `cockpit` | `board.mjs serve --open` detached | recorded, continue |
| `rotate` | `ledger.mjs rotate` | exit 2 → exit 3 with the refusal |
| `reclaim` | `reclaim-scratch.mjs --root <scratch> --after-rotate --apply` | recorded, continue |
| `recipe` | `derive-testcmd.sh . install` and `. test --at origin/main` | either exit 1 → `NEED derive-recipe` exit 4; exit 3 → exit 3 |
| `fold-in` | open PRs with no row rotate carried; writes `#M` rows for those closing an issue; lists the rest | `NEED review PR#M (closes no issue)` recorded, continue |
| `stranded` | `stranded.mjs` | `resume` entries → `NEED resume #N <worktree> <branch>` exit 4; `report` entries printed |
| `shortlist` | `shortlist.mjs` | exit 2 → exit 3 |

Exit 0: every step `ok`. Exit 4: a step needs the controller; the receipt
marks it `pending`, the script prints the need, and the controller does
that one thing (dispatch `derive-recipe`, dispatch `impl-<N>-b` by the
ordinary row/dispatch/task sequence) and re-runs `phase0.mjs`, which skips
every `ok` step for this run and re-checks the pending ones. Exit 3: a step
refused; the receipt records it `failed` with the output, and the run does
not start.

**D2. The receipt.** `.fleet/phase0.json`: `{run: <controller record at>,
session: <dir>, scratch: <root>, caps: {impl, review}, steps: {<name>:
{status: ok|pending|failed|drift|unanswered, at, output}}}`. `run` is the
`at` the rotate wrote into the controller record, and the tick compares it
with the current record's. That comparison alone does not separate two runs
before the new run's rotate: the record still carries the previous run's `at`
until `ledger.mjs rotate` writes the next, so the previous run's receipt
still matches it, and a re-run that trusted `run` alone would skip `rotate`.
Two rules close that. `phase0.mjs` resumes an existing receipt, skipping its
`ok` steps, only when its `run` equals the current record's `at` **and** its
`session` equals the `--session` it was given; any other receipt is moved
aside beside the ledger as a previous run's and the script starts at
`branch`. And `closeout.mjs finish` moves `phase0.json` beside the ledger
just before `fleet-heartbeat.mjs --stop`, so a run that ended cleanly leaves
no receipt for the next run's tick to read. A dead run's receipt, which no
close-out moved, is not told apart from this run's by the tick until
`phase0.mjs` has run; it is the run's first command. `session` is the
`--session` argument, which the tick, `tier-check.mjs --batch` and
`ticket-router.mjs` read from here when their own flag is omitted; `scratch`
is what `scratch-root.mjs` printed. `ledger.mjs rotate` archives
`phase0.json` and `closeout.json` beside the ledger under the same timestamp.

**D3. The tick gates on it.** Before its rows, the tick reads
`.fleet/phase0.json`. Missing, unreadable, `run` not equal to the current
controller record, or any step not `ok` (the `fold-in` and `ruleset` steps
excepted; `drift`, `unanswered` and a `fold-in` need are advice) prints
`PHASE0-INCOMPLETE <steps>` and holds every dispatching row, alongside the
`MAIN-CHECKOUT-*` family; the `CONFLICT` rows and the stall report still
print. `MAIN-CHECKOUT-NO-BASELINE` becomes one case of this line.

**D4. `closeout.mjs`.** `closeout.mjs --reason "<r>" [--branch <name>]`.
Two phases, because the middle of the end of run is the ordinary loop:

- `closeout.mjs begin --reason`: `ledger.mjs drain`; `release-ticket.sh
  --apply` for every claimed ticket with no PR, settling each `released`
  and listing every refusal as `NEED hand-release #N <blocker>`; writes
  `.fleet/closeout.json` `{begun}`.
- `closeout.mjs finish --reason [--branch]`: refuses (exit 3) unless the
  tick's last line was `ACTION: run over`, which it re-derives by running
  the tick itself. Then: scrape every session directory for this cwd;
  `tier-outcomes.mjs check --live`; refuse while any `reviewed=` PR lacks a
  tier-outcomes row, printing `NEED tier-outcomes append <pr>` for each
  (the verdicts are the controller's rulings; the script never guesses
  them); `metrics-refresh.mjs`; commit the three metrics files on `--branch`
  (default `chore/run-artifacts-<date>`, lettered when taken, this repo's
  convention per `AGENTS.md`, and the consumer's choice elsewhere); push;
  `gh pr create` labelled `patch`; `git switch main`; move `phase0.json`
  beside the ledger (D2); `fleet-heartbeat.mjs --stop "<reason>"` last. Each
  step is a receipt entry; a re-run skips `ok` steps.

**D5. SKILL.md.** Phase 0 step 0 becomes "run `phase0.mjs`; act on `NEED`
lines; re-run until exit 0". The paragraphs that explain each step
move to the script's header comment and to `references/phase-0.md`, which
the controller reads only when a step refuses. End of run becomes the two
`closeout.mjs` calls.

**D6. Tests.** A fixture repo drives `phase0.mjs` end to end with stubbed
`gh` and `omp` on `PATH`: one case per step proving its failure stops the
script and is named in the receipt; one case per `NEED` proving a re-run
resumes at the pending step; one proving a receipt with a stale `run` is
ignored by the tick; one proving a re-run in a new session, with the previous
run's receipt on disk, starts at `branch` instead of skipping `rotate`. The
same for `closeout.mjs finish`, including the refusal on a missing
tier-outcomes row and the move of `phase0.json` before `--stop`.

## Out of Scope

- The per-wake commands and the tick executing idempotent actions (spec 4).
- Changing any step's semantics, or the relative order of the runbook's
  Phase 0 steps. The table keeps that order for the steps the runbook
  states there, with the edit of form that `branch` is split out of the
  fast-forward paragraph. `tier-roles`, which the runbook states only in
  Phase 2 and gives no Phase 0 position, is placed by the driver between
  `ruleset` and `metrics`.
- Phase 0 dispatching a member itself. The two member needs stay the
  controller's one `task` call each.

## Open Questions

- Whether `cockpit` belongs in the receipt at all, given it is idempotent
  and never gates anything. Lean: recorded, never a hold.
- Whether `tier-roles --check` belongs in phase 0 at all. The runbook
  states it in Phase 2, before the run's first dispatch, and names it in
  no Phase 0 paragraph. Placed between `ruleset` and `metrics`, the order
  `STEPS` in `phase0.mjs` pins, a bad route stops the run before
  `metrics`, `rotate` and every later step.
