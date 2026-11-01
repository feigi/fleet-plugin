# Finisher

## What it is for

The last gate before `ready-to-merge`: a small, fresh agent that audits
a fixed PR's worktree, confirms every review finding landed somewhere
durable, and applies the label the merge bot waits on.

## How it works
1. **Dispatch trigger — a controller rule, not a tick row.** The
   controller dispatches
   [`fleet-finisher`](../../plugin/agents/fleet-finisher.agent.md) — an agent
   whose body carries the finisher's duties, and whose controller-side duty list lives in
   [`plugin/skills/run-team/SKILL.md`](../../plugin/skills/run-team/SKILL.md)
   — directly. Check green only makes a PR a *candidate*; the gate is
   the review has returned and its fix-applier, if dispatched, has
   reported — a `no-op` report clears it immediately, against the
   existing head, with no new CI run. With `verdict: "no-ci"`, it
   dispatches off the reviewer's final verdict instead, gated on
   `--declare-no-ci`.
2. **Audit the worktree** by running one script,
   [`finisher-audit.mjs`](../../plugin/scripts/finisher-audit.mjs), which
   finds the worktree's row in
   [`worktree-audit.sh`](../../plugin/scripts/worktree-audit.sh)'s output,
   checks it for dirty, unreadable, missing, or absent state, compares the
   worktree's `HEAD` against the dispatch pin, and names the cause of any
   divergence — a non-null cause halts before the label. A worktree that
   differs from the pin but holds nothing the pin lacks, because a remote
   rebase superseded it, is clean; a commit the pin lacks that no remote ref
   carries is a `stray` halt.
3. **Confirm durable homes.** A deferral of a finding in the review's
   result is judged by the `dispositions-ok` verdict
   [`ledger.mjs`](../../plugin/scripts/ledger.mjs) `dispatch` required
   before dispatching the finisher, not re-judged by hand — the PR's
   closed `wontfix` suggestion-band record, matching
   [`dispositions-check.mjs`](../../plugin/scripts/dispositions-check.mjs)'s
   `homeHolds`, is one such home. Every other deferral and claimed apply
   needs a tracker issue or in-tree comment (via `ledger.mjs check`,
   filing what isn't found), and every "applied" claim is re-verified
   against `git diff origin/main...<dispatch pin>`, plus the acceptance mutation
   re-run in the finisher's own detached worktree (never the owned one).
   The re-run is skipped on an **Inert diff**, which
   [`finisher-scope.mjs`](../../plugin/scripts/finisher-scope.mjs) reads at
   the dispatch pin: every path plain Markdown outside the prompt surface, or
   a run-metrics file. Any other exit runs the mutation. It is skipped too
   for a **Ticketless PR** — one that closes no issue in its own repository
   and that no settled `impl-<N>=PR#<M>` token names, as
   [`ticketless.mjs`](../../plugin/scripts/ticketless.mjs) reads it — because
   no ticket supplies a mutation to re-run; the report says so where a kill's
   evidence line would go.
4. **Add `ready-to-merge`** — only after finding *exactly one* release
   label among `patch`/`minor`/`major` on the PR (more than one halts,
   naming what was found, and so does none on a ticket PR; a Ticketless PR
   with none gets `patch` added first). A Ticketless PR is then labelled
   only when its diff is an Inert diff: otherwise the script posts the
   `ready-to-merge-head:` record, adds no label and exits 5, the finisher
   halts `human`, and the maintainer's `ready-to-merge` is the merge.
5. **Report** the label, every filed deferral's issue number, and any
   halt cause. Re-checks [Instruments](instruments.md) before acting on
   either read and again before adding the label.

## Opinionated choices

- **The finisher, not the fix-applier or reviewer, applies
  `ready-to-merge`.** A deliberate last independent check rather than
  trusting the review pipeline's own account of itself — a final report
  was twice measured not to be proof a member actually stopped.
- **Everything it verifies by running, it runs in a tree nobody else
  owns** — an add-detach, install, mutate, remove cycle in its own scratch
  worktree, never the PR's own, because two members writing the same
  tree at once was measured to silently destroy uncommitted work.
  `finisher-tree.mjs` builds the tree and runs the Install step in it, as
  a claim does: a detached worktree holds tracked files only, so a suite
  whose dependencies are ignored cannot start without it.
- **A deliberately cheap tier** ([Tier routing](tier-routing.md)) is
  acceptable for the same reason it is on the [Merge bot](merge-bot.md):
  the merge gate downstream still catches whatever the finisher gets
  wrong.
