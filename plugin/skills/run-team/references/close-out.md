# Close-out: what each metrics step does and why

`closeout.mjs finish` runs the scrape, the tier-outcomes check, the metrics refresh, the commit of the metrics files, and the phase-0 receipt move, and SKILL.md's **End of run** says how to drive it. This file is how each of those works, for the controller to read when a step refuses. The verdict rules — what `closed_own_ticket` and `minted_false_claim` mean, and that a value not in hand is left blank — stay in SKILL.md under **Guard: accumulate per PR**, because the controller still rules them.

## Scrape the member facts and check the tier rows

**Then record the run's member facts — do not author them.** Scrape EVERY session
directory for this cwd, not one:

```bash
PROJECT_DIR="$(node -e 'import("./scripts/member-record.mjs").then(m => console.log(m.encodeProjectDir(process.cwd())))')"
for d in "$HOME/.omp/agent/sessions/$PROJECT_DIR"/*/; do
  node scripts/member-outcomes.mjs "$d"
done
```

`encodeProjectDir` (defined in `scripts/member-record.mjs`) encodes the cwd
exactly as omp names its session directories — see its comment for the rule — and hand-guessing that path is why
the fleet's own panel once rendered nothing here. The trailing `/` on the glob matters:
the same encoded-cwd directory also holds this cwd's own top-level session
transcripts as loose FILES sibling to the per-session directories, and a
glob without it would try to scrape one of those as if it were a session.

**Do not narrow this to "this run's session" with `findSubagentsDir`.** That helper
answers a different question — the session with the NEWEST transcript for this cwd,
which is not the same as the one you are in. Any other session sharing this cwd —
a second terminal, a second controller run — can hold a newer transcript than
yours at the moment you reach this step, and a second session dispatching
anything while you reach it wins the tie: the run then re-scrapes a stranger's
members, prints a plausible row count and exits 0 while its own facts are
never recorded. Looping every session dir costs a few seconds, cannot pick
wrong, and is idempotent by construction.

The scraper takes the session directory itself and refuses a path it cannot
read — a missing, unreadable or non-directory path all exit 2 — so a wrong
path fails loudly instead of writing nothing and exiting 0. It reports the
run's own YIELD, `scraped N of M members (D dropped)`, alongside the file's
total: read the yield, because the total is the whole corpus and looks
healthy even when every member of this session dropped.

It derives every row from the member transcripts omp already wrote — both the
flat ones and a member's own nested fan-out one level down — so a
second run over the same session changes nothing and a re-run after a member is
re-dispatched picks the new transcript up. **Never hand-edit
`docs/metrics/member-outcomes.tsv`** — it is regenerated wholesale whenever the
role classifier changes, and a hand-entered value would not survive that. The
verdict for a PR goes to `tier-outcomes.tsv` through `tier-outcomes.mjs
append`, as above. Once both files hold this run's rows, and before either is
committed, run `~/.fleet/bin/fleet-run tier-outcomes.mjs check --live`. Exit 1
names each row whose `tier` disagrees with the one implementer the member facts
say ran for its ticket: correct that row's `tier` to the short name it prints,
or blank it and say why in `note`. Exit 1 also names the PRs of the case where
the latest `run_date`'s filled rows have no implementer row in the member file
and none could be compared, so nothing from that run was checked: append the
run's member rows if they are missing, or blank each named row's `tier` and say
why in `note`.
Each WARNING names a PR this run's ledger marks `reviewed=` that has no row yet
— append it before committing if it is an implementer PR.

## Drain the pending ticket-features rows and refresh the cost guard

**Drain the pending ticket-features rows and refresh the cost guard, after
the member-outcomes scrape and every `tier-outcomes.mjs append`, before the
metrics files are committed.** `~/.fleet/bin/fleet-run metrics-refresh.mjs`
moves `.fleet/ticket-features.pending.tsv` — the row the router script
appended for each Pull at dispatch — into `docs/metrics/ticket-features.tsv`,
deduped on `session`+`agent`, so this run's own rows are in the file that gets
committed; that file is a run artifact too and is committed with the other
two. It then runs `pr-cost.mjs --guard`, which rewrites
`.fleet/cost-guard.json` from all three files. Exit 0: both ran. The guard's
own exit 3 (a cell tripped) and 4 (no verdict yet, baseline too thin) are
verdicts the router and `fleet-tick.mjs` read, never failures; the script
absorbs them. Exit 1 names the duty that failed on stderr and the duty after it
did not run; exit 2 is a usage error. At close-out a failure fails the
`metrics` step of `closeout.mjs finish`, so `commit-and-pr` stays pending: fix
the cause and run `finish` again — the pending file stays in `.fleet/` and the
next run's phase-0 pass drains it — and never commit the metrics files with a
drain that failed claiming the corpus is complete.

## Commit the metrics files and open a PR

The metrics files are the run's own artifacts and none commits itself. Carry
them to main the same way the run carries any other controller-authored change;
leaving a regenerated 5,000-row corpus uncommitted in the checkout is how it gets
discarded by the next `git checkout` with nothing to show it ever ran.

**Commit the metrics files and open a PR — at end of run.** The branch name is
the repository's choice. Make the commit on a branch in the main checkout,
switch back to `main` before the next tick, and never `--record` while on that
branch; the round trip reads clean. A PR still open when the run ends is one phase 0's
fold-in queues for review next run, however it is named, so the files reach
`main` through the same review as ticket work rather than being lost. Stranding
a data row loses it: `member-outcomes.tsv` is regenerated from harness
transcripts the fleet does not own, so re-running the scrape later is worth
only what the harness still holds.

## Move the phase-0 receipt

**Set aside the phase-0 receipt after the commit — before the heartbeat.** The receipt `.fleet/phase0.json` records what phase 0 decided and the run's tracing; `closeout.mjs finish` moves it to `.fleet/phase0.previous.json` so the next run can find it under the name `phase0.mjs` reserves for a previous run's receipt, and that run's rotation restores and archives it with the ledger. A missing `.fleet/phase0.json` counts as nothing to move and is `ok`.

The step can refuse in two ways:

- `.fleet/phase0.previous.json` already holds a receipt from a different run. **Move it out of the way, then run finish again.** This happens when a previous run's close-out moved its receipt there but the next run never rotated — a controller crash between the move and rotation, or a stalled or deleted run before rotation. Clean it up by hand and resume.
- The receipt was moved to the destination but the original copy could not be removed. **Remove it by hand before the next run.** A rare race: the link succeeded but the unlink failed on a stray filesystem error or permission issue. Delete the `.fleet/phase0.json` file so the next run does not try to move it again.
