# 0029 — Scratch is reclaimed on GitHub terminal state and age, by a script distinct from Reap

**Status:** Accepted. Ruled 2026-10-12 by the maintainer in a grilling session
on #2316, against `main` at `c54a597d`, and amended the same day (main
`532b8f48`) to add `--after-rotate`. Builds on ADR 0027, which fixed where the
scratch root lives and left its cleanup to #2316. Amended by #3317: decisions
1 and 3 are extended by decision 11, the sibling keys. Amended by #3403: an
OPEN ticket's `impl-<N>/` is also kept while a claim worktree under
`.worktrees/` still stands for it, and is judged by the 7-day rule once none does.

## Context

The review snapshot's inline prune was the only reclamation under the scratch
root, and it reached only `<root>/pr<N>/run-*` roots older than 7 days — and
only when PR #N was reviewed again. A merged or closed PR is never reviewed
again, so its tree stayed. Member partitions (`impl-<N>/`), fix-applier
disposition records and the controller's own files at the root had no
reclamation at all.

## Evidence

Measured 2026-10-12, as recorded in the ruling comment on #2316. Every
`file:line` below is a line of that file at `main` `c54a597d`, before this
change; in the files this change edits those numbers no longer hold.

| Fact | Evidence |
|---|---|
| Key dir `~/.fleet/scratch/fleet-plugin-28971265/`: 5.3 G after 0.7 d — 12 `pr<N>` (11 MERGED), 12 `impl-<N>` (10 CLOSED), 12 `dispositions-*.json`, ~12 controller ad-hoc files at the root | scandir + `gh api graphql` |
| Nothing reads a PR's scratch after it merges. Readers before: `impl-<N>-b` inherits `impl-<N>/` (`SKILL.md:590`); the liveness check reads mtimes anywhere under the partition (`:4091`); `dispositions-check.mjs` reads `<root>/pr<M>/<run>/review.json` off the latest `reviewed=` and `<root>/dispositions-<member>.json` (`:1676`) | grep |
| The ledger never records "merged": a row ends at `finisher-pr-M=labelled` / `merge-bot-<n>=done`; `reviewed=` carries a run id, no path | `.fleet/ledger.md` |
| `reap.sh` authorizes on git evidence only (`[gone]` + `git cherry`); its branchless sweep is bounded to `.worktrees/` and reports scratch trees as `kept` (`SKILL.md:3092`). It fires on the merge-bot pass report (`:1682`), never at end of run (`:3578`) | `reap.sh:1631` |
| The only reclamation was `review-core.mjs:844`: inline `find pr<N> -maxdepth 1 -name 'run-*' -mtime +7` → `chmod -R u+rwx` → `chflags -R nouchg,nouappnd` → `rm -rf`, else `SNAPSHOT_PRUNE_FAILED`; pinned by `tests/snapshot-repo.test.mjs`, `tests/review-core-snapshot-path.test.mjs` | grep |
| Legacy roots: `<repo>/.fleet/scratch` 34 G (336 `pr<N>` all MERGED, 235 `impl-<N>` all CLOSED); `~/.fleet/scratch/` outside the key dir 11 G (80/81 `pr<N>` MERGED). No `uchg`/`uappnd` flag and no unreadable dir in either | transcripts |
| `ledger.mjs rotate` leaves **no** `.fleet/ledger.md` after a `dead`/`none` verdict, or an `ancestor` verdict carrying nothing. Only an `ancestor` verdict carrying ≥1 token leaves a file, holding exactly the carried rows. Nothing in Phase 0 after rotate writes the ledger; an idle run never writes it | `ledger.mjs:1646-1707`, `SKILL.md:1999` |

## Decision

1. **Two jobs, one in the plugin.** The plugin ships a steady-state reclaim of
   the scratch root only. The legacy roots (`<repo>/.fleet/scratch`, and
   `~/.fleet/scratch/` outside the repo-key directories) are purged by hand,
   once.
2. **Term and script: Reclaim, `plugin/scripts/reclaim-scratch.mjs`.**
   Distinct from Reap (git evidence) and Release (a claim that never became a
   PR): Reclaim authorizes on GitHub state and age.
3. **Trigger: two controller edges.** (i) The merge-bot pass report, as
   `reclaim-scratch.mjs --root <scratch> --apply` straight after
   `reap.sh --apply`. (ii) Phase 0, straight after `ledger.mjs rotate`, as
   `reclaim-scratch.mjs --root <scratch> --after-rotate --apply`, so a run
   that merges nothing still reclaims the previous run's leftovers. The
   controller records nothing on the ledger and acts on nothing in the
   receipt.
4. **`pr<M>/` and `dispositions-fix-pr-<M>*.json`:** reclaimed when PR #M is
   MERGED or CLOSED on GitHub and no live ledger token names it
   (`review-pr-<M>`, `fix-pr-<M>`, `finisher-pr-<M>`, any retry suffix). Any
   live `merge-bot-<n>` holds all `pr<N>` reclamation for that sweep. An OPEN
   PR's `pr<M>/` is kept, except its `run-*` roots (rule 7).
5. **`impl-<N>/`:** reclaimed when the issue is CLOSED, or OPEN with no live
   `impl-<N>` token and idle past the retention.
6. **Age rule, 7 days.** Every other entry at the root is reclaimed when idle
   past 7 days and no live token's name appears in its name. "Idle" is the
   newest mtime anywhere under the entry, never the top-level mtime. A keyed
   name whose number GitHub resolves to the other type, or to nothing, is
   judged by this rule.
7. **`--pr <N>` replaces the inline prune.** Age-only on `<root>/pr<N>/run-*`,
   no ledger, no `gh`; review-core prints `SNAPSHOT_PRUNE_FAILED` when the
   receipt's `failed[]` is non-empty or no receipt is printed. The
   `chmod -R u+rwx` → `chflags -R nouchg,nouappnd` → `rm -rf` sequence lives
   in the script as its single copy, and every removal goes through it.
8. **`gh`:** one `gh api graphql` per ≤100 numbers. With `gh` unreachable every
   keyed entry is kept with that reason, and so is one whose number the
   answer errored on: a null alias reads as "names nothing" only with a
   NOT_FOUND error naming it; any other error naming an alias, an error
   naming none, and a null without NOT_FOUND each leave the number
   unanswered. The age rule still runs on unkeyed entries. No fallback
   to the ledger or to mtime for keyed entries.
9. **Contract, mirroring `reap.sh`:** dry run by default, `--apply` mutates,
   `--root <abs>` required. The root sweep reads `.fleet/ledger.md` and
   refuses when it is absent, unless `--after-rotate` is given, under which
   an absent file reads as no live token. Only ENOENT is absence. One JSON
   receipt line, `{applied, ledger, removed, kept, failed}`; removal is
   best-effort per entry; non-zero only for a refused invocation.
10. **Shapes unchanged.** `dispositions-<member>.json` stays at the root.
11. **Sibling keys (amends 1 and 3, #3317).** `reclaim-scratch.mjs --siblings
    --root <scratch> [--apply]` judges every key-shaped directory directly under
    the scratch parent (`~/.fleet/scratch/`) other than the live key, by age
    alone: one with nothing modified in 7 days goes whole, one with anything
    fresh stays whole, and so does one with any part that cannot be read. Each
    is judged again just before `--apply` removes it. `--root` must be this
    workspace's own scratch root, so the live key is never judged. Entries that
    are not key-shaped, and links, are not judged. It reads no ledger and its
    receipt carries `ledger: null`. Phase 0 runs it straight after the root
    sweep, whatever the sweep answered; a failure, and what either receipt's
    `failed[]` names, is recorded and never fails the run.

## Consequences

- `--after-rotate` rather than a `--no-ledger`: `dispositions-check.mjs`'s
  `--no-ledger` means "do not look", which would unprotect a carried
  `merge-bot-*` token; `--after-rotate` still reads a ledger rotate left.
- Rejected for the Phase 0 edge: moving it after the first ledger write (an
  idle run never writes one); reading any missing ledger as "nothing live"
  (a sweep resolving the ledger from the wrong cwd would silently unprotect
  every keyed entry); and reading rotate's archive or recorded verdict (every
  token in a `dead`/`none` archive is dead by rotate's own verdict, and under
  `ancestor` the carried file already exists).
- Shipped-surface prose (ADR 0019): `plugin/` states the rule and cites
  nothing; provenance lives here, in `CONTEXT.md`'s **Reclaim** term and in
  `docs/components/scratch-reclaim.md`.
