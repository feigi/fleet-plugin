# 0036 — An idle claim tree is evicted: its installed dependencies go, the claim stays

**Status:** Accepted. Ruled 2026-10-31 by the maintainer in a grilling session
on #3994, against `main` at `ff574efe`. The ruling replaces the issue body's
proposed remedy, which removed the whole worktree.

## Context

A claim tree — `.worktrees/<N>-impl-<N>[-x]` on `implementer/<N>-impl-<N>[-x]`
— keeps everything its claim's Install step installed for as long as the claim
stands. Reap removes it after the merge, Release removes a claim that never
became a PR, and Reclaim touches scratch only, so nothing frees an open PR's
tree however long nobody works in it. #3994 records the cost on a consumer
repository: about 1.2 GB of `node_modules` per tree, and open PRs that went ten
days without a commit, the third time a disk filled.

## Decision

1. **Term and script: Evict, `plugin/scripts/evict.mjs`.** Evict removes a
   claim tree's installed dependencies — every path git ignores in it except
   the `agent-test` runner — once 7 days pass with neither a HEAD move nor a
   restore in it. The claim, its tree, its branch and its commits stay. It is
   not Reap, Release or Reclaim, which remove things.
2. **Reclaim's contract.** Dry run by default, `--apply` mutates, one JSON
   receipt line `{applied, ledger, evicted, kept, failed}`, best-effort per
   tree, non-zero only for a refused invocation. The ledger is read as Reclaim
   reads it: an absent `.fleet/ledger.md` refuses, except under
   `--after-rotate`, where it means no live token; only ENOENT is absence.
3. **Candidates.** A git-registered worktree directly under the checkout's
   `.worktrees/` whose directory and branch match `stranded.mjs`'s
   `CLAIM_WORKTREE` and `CLAIM_BRANCH`, whatever its PR's state. The script
   makes no `gh` call.
4. **Kept, each with its reason:** already marked; nothing ignored but the
   runner; a non-empty `git status --porcelain -uall`; a git operation in
   progress (the state `worktree.sh`'s `wt_op_state` reads); the script's own
   cwd inside it; a live member token on a row that names its ticket — the row
   keyed `#N`, or a fold-in row `PR#<M> · inherited (closes …)` whose list
   names `#N` — or a live token on a row naming no ticket with a claim tree
   here, which keeps every candidate because the tree its member works in
   cannot be told; HEAD moved or a restore ran within 7 days, the newer of the
   tree's own HEAD reflog's newest entry (HEAD's commit date when it is empty)
   and its restore time; and anything it cannot read.
5. **`--apply`** judges the tree again, writes the mark `fleet-evicted` into
   its git admin dir, then deletes every ignored path but the runner through
   Reclaim's one removal sequence. Tracked files, HEAD, the branch and the
   registration are untouched. A tree whose deletion fails keeps its mark and
   is named in `failed`.
6. **Restore.** `evict.mjs --restore <abs tree> --apply` runs the Install step
   as `claim-ticket.sh` does after `worktree add` and refuses as the claim
   does: exit 126/127 as a Recipe that no longer runs, any other non-zero as a
   failed install, a dirty tree after it as an Install step that changed the
   tree. Only once the tree is clean does it record the restore time
   (`fleet-restored`) and remove the mark; every refusal leaves the mark.
7. **Refusal at dispatch.** `dispatch-prompt.mjs render implementer` and
   `render fix-applier`, every kind, refuse a marked worktree and print the
   restore command; the controller runs it, then renders again. `render
   review-runner` and `render finisher` are unaffected: the review works in
   its own snapshot, the finisher in its own detached tree. A failed restore
   adds no state: the mark stays, nothing is dispatched into the tree, and the
   row comes up again on the next wake.
8. **Two edges.** Phase 0 runs `evict.mjs --after-rotate --apply` as its own
   step straight after `reclaim`, recorded and never failing the run. The
   tick's follow-up after a settled merge pass runs `evict.mjs --apply`
   straight after `reclaim-scratch.mjs`, reported as reclaim's duty is.

## Rejected

- **Removing the whole worktree** (the issue body's remedy): every member
  working from the tree would need a re-create step; a stranded claim without
  its tree is only reported; Reclaim would then drop `impl-<N>/`, which the
  fix-applier render reads the ticket from; and `HEAD == origin/<branch>`
  fails after every server-side rebase.
- **A free-space floor:** under pressure it evicts trees between their fix
  rounds, and it runs only at these edges, never before the write that fills a
  disk — a capacity guard, not this.
- **Sweeping the host's other checkouts:** the only option that could free a
  dead run's gap, but it needs a list of the host's checkouts, and ADR 0025
  decision 2 puts other checkouts out of scope.
- **Evicting at a run's end:** a run that ends on purpose stops only once it
  is draining with no open PR left.
- **Idle by newest mtime**, which walks every `node_modules`, **or by the PR's
  `updatedAt`**, which the fleet's own `ready-to-merge-head:` comment bumps.

## Consequences

- An open PR's tree idle past 7 days holds its source and its runner only; a
  member dispatched into it waits on one restore.
- Removing a claim tree or its branch while the claim stands, review scratch
  volume, any free-space floor and other checkouts on the host stay out of
  scope.
- Reap removes an evicted, merged claim tree as it removes any other: it reads
  neither file the eviction leaves in the admin dir, and `git worktree remove`
  takes the admin dir with it.
