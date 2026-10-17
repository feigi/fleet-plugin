# Scratch Reclaim

## What it is for

Every member writes under the run's scratch root, `~/.fleet/scratch/<repo-key>/`
([ADR 0027](../adr/0027-the-scratch-root-is-computed-not-injected.md)):
review run roots under `pr<N>/`, an implementer's `impl-<N>/`, fix-applier
disposition records and the controller's own files at the root. **Reclaim**
removes each of them once nothing can still want it, so the root holds the
work in flight rather than every run's history.

## How it works

1. **Two controller edges run the root sweep.**
   [`reclaim-scratch.mjs`](../../plugin/scripts/reclaim-scratch.mjs)
   `--root <scratch> --apply` runs straight after `reap.sh --apply` on every
   merge-bot pass report, and `--root <scratch> --after-rotate --apply` runs in
   phase 0 straight after `ledger.mjs rotate`, so a run that merges nothing
   still reclaims the previous run's leftovers.
2. **Keyed entries are judged on GitHub state.** One `gh api graphql` call per
   ≤100 numbers asks what each `pr<N>` and `impl-<N>` is. A merged or closed
   PR's `pr<M>/` and `dispositions-fix-pr-<M>*.json` go unless a live
   `review-pr-<M>`, `fix-pr-<M>` or `finisher-pr-<M>` token names it; any live
   `merge-bot-<n>` holds every `pr<N>`. A closed issue's `impl-<N>/` goes; an
   open one's goes only with no live `impl-<N>` token and 7 days idle. A
   number `gh` gives no usable answer for — `gh` unreachable, or a partial
   failure that errored on it — keeps every keyed entry that names it. A
   member's report file, `reports/<member>.json`, goes with the entry its
   member belongs to: a `fix-pr-<M>`, `finisher-pr-<M>` or `review-pr-<M>`
   report with `pr<M>/` (whether or not that directory exists), an
   `impl-<N>` report with `impl-<N>/`. `reports/` itself is never removed;
   each file in it is judged on its own.
3. **Everything else is judged on age.** An entry goes when nothing anywhere
   under it has changed in 7 days and no live token's name appears in its
   name. A keyed name whose number is the other type, or nothing, falls here,
   and so does a `merge-bot-<n>` report, which names no PR and no ticket.
4. **The review snapshot prunes its own PR.** `review-core.mjs` runs
   `reclaim-scratch.mjs --pr <N>`, which removes only `pr<N>/run-*` roots idle
   past 7 days — no ledger, no `gh` — and prints `SNAPSHOT_PRUNE_FAILED` when
   the receipt names a failed removal.
5. **One removal sequence.** Every removal restores owner rwx, clears darwin's
   `uchg`/`uappnd` flags where `chflags` exists, then `rm -rf`, so a fixture
   that dropped its own read bit cannot wedge it. A removal that still fails is
   reported in the receipt's `failed[]`, and the sweep goes on.
6. **Sibling keys are judged on age alone.** `reclaim-scratch.mjs --siblings
   --root <scratch>` judges each key-shaped directory directly under the scratch
   parent, other than the live key: one with nothing modified in 7 days goes
   whole, one with anything fresh stays whole. Entries that are not key-shaped,
   and links, are never judged. Its receipt carries `ledger: null`, and its
   reason names the sibling key. Phase 0 runs it on every pass, straight after
   the root sweep, whatever the root sweep answered.

## Opinionated choices

- **Reclaim is not Reap.** Reap deletes branches and worktrees on git's own
  evidence; scratch has no branch to measure, and the ledger never records
  "merged", so Reclaim asks GitHub and the clock instead — a separate script,
  so neither borrows the other's authorization
  ([ADR 0029](../adr/0029-scratch-is-reclaimed-on-github-terminal-state-and-age.md)).
- **No ledger refuses, except straight after rotate.** Without the ledger no
  live member can hold its scratch, so the root sweep refuses rather than
  reading absence as permission. `ledger.mjs rotate` leaves no ledger when it
  carried nothing, so `--after-rotate` — and only that flag — reads absence as
  rotate's own verdict: no live token.
- **Idle means the newest mtime anywhere under the entry.** A write deep in a
  tree does not move its top-level mtime, so that alone would delete a live
  member's partition.
- **Dry run by default.** Like `reap.sh`, the script reports what it would
  remove unless given `--apply`, and prints the same receipt either way.
