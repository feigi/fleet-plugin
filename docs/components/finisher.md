# Finisher

## What it is for

The last gate before `ready-to-merge`: a small, fresh agent that audits
a fixed PR's worktree, confirms every review finding landed somewhere
durable, and applies the label the merge bot waits on.

## How it works
1. **Dispatch trigger — a controller rule, not a tick row.** The
   controller dispatches
   [`fleet-finisher`](../../plugin/agents/fleet-finisher.agent.md) — a
   7-line stub whose duty list lives in
   [`plugin/skills/run-team/SKILL.md`](../../plugin/skills/run-team/SKILL.md)
   — directly. Check green only makes a PR a *candidate*; the gate is
   the review has returned and its fix-applier, if dispatched, has
   reported — a `no-op` report clears it immediately, against the
   existing head, with no new CI run. With `verdict: "no-ci"`, it
   dispatches off the reviewer's final verdict instead, gated on
   `--declare-no-ci`.
2. **Audit the worktree** via
   [`worktree-audit.sh`](../../plugin/scripts/worktree-audit.sh) for
   dirty, unreadable, missing, or absent state, and check the
   worktree's `HEAD` against the dispatch pin for divergence — any of
   the five halts before the label.
3. **Confirm durable homes.** Every deferral and claimed apply needs a
   tracker issue or in-tree comment (via `ledger.mjs check`, filing what
   isn't found), and every "applied" claim is re-verified against `git
   diff origin/main...HEAD`, plus the acceptance mutation re-run in the
   finisher's own detached worktree (never the owned one).
4. **Add `ready-to-merge`** — only after finding *exactly one* release
   label among `patch`/`minor`/`major` on the PR (zero or more than one
   halts, naming what was found).
5. **Report** the label, every filed deferral's issue number, and any
   halt cause. Re-checks [Instruments](instruments.md) before acting on
   either read and again before adding the label.

## Opinionated choices

- **The finisher, not the fix-applier or reviewer, applies
  `ready-to-merge`.** A deliberate last independent check rather than
  trusting the review pipeline's own account of itself — a final report
  was twice measured not to be proof a member actually stopped.
- **Everything it verifies by running, it runs in a tree nobody else
  owns** — an add-detach, mutate, remove cycle in its own scratch
  worktree, never the PR's own, because two members writing the same
  tree at once was measured to silently destroy uncommitted work.
- **A deliberately cheap tier** ([Tier routing](tier-routing.md)) is
  acceptable for the same reason it is on the [Merge bot](merge-bot.md):
  the merge gate downstream still catches whatever the finisher gets
  wrong.
