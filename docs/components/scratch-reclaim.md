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
   still reclaims the previous run's leftovers. In every mode `--root` must be
   this workspace's own scratch root, the path `scratch-root.mjs` prints from
   the same cwd. The root sweep refuses any other, dry run included, and
   when its own scratch root cannot be resolved: it reads the ledger, the
   claim worktrees and GitHub of the repository the cwd is in, so another
   workspace's key would be judged against this one's numbers.
2. **Keyed entries are judged on GitHub state.** One `gh api graphql` call per
   ≤100 numbers asks what each `pr<N>` and `impl-<N>` is. A merged or closed
   PR's `pr<M>/` and `dispositions-fix-pr-<M>*.json` go unless a live
   `review-pr-<M>`, `fix-pr-<M>` or `finisher-pr-<M>` token names it; any live
   `merge-bot-<n>` holds every `pr<N>`. A closed issue's `impl-<N>/` goes; an
   open one's goes only with no live `impl-<N>` token, no claim worktree under
   `.worktrees/` standing for it, and 7 days idle. A
   number `gh` gives no usable answer for — `gh` unreachable, or a partial
   failure that errored on it — keeps every keyed entry that names it. A
   member's report file, `reports/<member>.json`, goes with the entry its
   member belongs to: a `fix-pr-<M>`, `finisher-pr-<M>` or `review-pr-<M>`
   report with `pr<M>/` (whether or not that directory exists), an
   `impl-<N>` report with `impl-<N>/`. The Check-step record written beside
   it, `reports/<member>.check.json`, goes with its report under the same
   verdict and the same live-token holds; only the single `.check` infix
   counts, so `<member>.check.check.json` and `<member>.checkx.json` fall to
   age. `reports/` itself is never removed; each file in it is judged on its
   own.
3. **Everything else is judged on age.** An entry goes when nothing anywhere
   under it has changed in 7 days and no live token's name appears in its
   name. A keyed name whose number is the other type, or nothing, falls here,
   and so does a `merge-bot-<n>` report or check record, which names no PR and
   no ticket.
4. **The review snapshot prunes its own PR.** `review-core.mjs` runs
   `reclaim-scratch.mjs --pr <N>`, which removes only `pr<N>/run-*` roots idle
   past 7 days — no ledger, no `gh` — and prints `SNAPSHOT_PRUNE_FAILED` when
   the receipt names a failed removal. Reading nothing the cwd decides, it
   does not check that `--root` is this workspace's own.
5. **One removal sequence.** Every removal restores owner rwx, clears darwin's
   `uchg`/`uappnd` flags where `chflags` exists, then `rm -rf`, so a fixture
   that dropped its own read bit cannot wedge it. A removal that still fails is
   reported in the receipt's `failed[]`, and the sweep goes on.
6. **Sibling keys are judged by the checkout they record.** A key's top level
   holds `checkout-path`, one line naming the absolute, canonical checkout the
   key's hash is taken over. `reclaim-scratch.mjs --siblings --root <scratch>
   --apply` first writes its own key's file when it is missing or says anything
   else, a temp file renamed over it, and writes no other key's; a dry run
   writes nothing, and a failed write lands in `failed[]`. It then judges each
   key-shaped directory directly under the scratch parent, other than the live
   key. A key whose file is missing, unreadable, not one absolute path, or a path
   that does not hash to the key's suffix is kept, having no checkout file; one
   whose checkout still exists is kept, its own phase 0 reclaims it; one whose
   checkout and the directory that held it are both gone is kept, since an
   unplugged drive reads the same. Only a key whose checkout is gone while that
   directory is present goes, whole, and only when nothing under it changed in
   7 days and every part of it could be read. `--apply` takes the whole verdict
   again just before removing a key. The pass asks GitHub nothing. `--root` must
   be this workspace's own scratch root. Entries that are not key-shaped, and
   links, are never judged. Its receipt carries `ledger: null`, and each kept
   entry says, as `idle`, whether nothing under the key was found modified in 7
   days. The root sweep never judges `checkout-path`. Phase 0 runs the pass on
   every pass, straight after the root sweep, whatever the root sweep answered,
   names each key it removed and each it kept with nothing modified in 7 days,
   with the reason, and lists what either pass's `failed[]` names.

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
