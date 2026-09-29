# Finisher

## What it is for

The last gate before `ready-to-merge`: a small, fresh agent that audits a
fixed PR's worktree, confirms every review finding landed somewhere
durable, and applies the label the merge bot waits on.

## How it works

The controller dispatches
[`fleet-finisher`](../../plugin/agents/fleet-finisher.agent.md) — a
7-line stub whose whole duty list lives in
[`plugin/skills/run-team/SKILL.md`](../../plugin/skills/run-team/SKILL.md)'s
Reviewers section, never in the agent file itself — once the
diff-validating CI job is green, the PR's review has returned, and its
fix-applier (if one was dispatched) has reported, *and* the controller
owes that fix-applier no outstanding ruling. Four duties, in order: (1)
**audit the worktree** via
[`worktree-audit.sh`](../../plugin/scripts/worktree-audit.sh) for dirty,
diverged, unreadable, missing, or absent state — any of the five halts
before the label; (2) **confirm every deferral and every claimed apply
has a durable home** — a tracker issue or an in-tree comment, via
`ledger.mjs check`, filing what isn't found — and independently
re-verify each fix-applier "applied" claim against `git diff
origin/main...HEAD`, plus re-run the ticket's acceptance mutation in the
finisher's own detached worktree (never writing to the owned one); (3)
**add `ready-to-merge`** — but only after reading the PR's own labels
back and finding *exactly one* release label among
`patch`/`minor`/`major` (zero or more than one halts the finisher, naming
what it found); (4) **report** the label, every filed deferral's issue
number, and any halt cause. The finisher re-checks
[Instruments](instruments.md) before acting on either read and again
before adding the label.

## Opinionated choices

The finisher, not the fix-applier or the reviewer, is the one member
that applies `ready-to-merge` — a deliberate last independent check
rather than trusting the review pipeline's own account of itself, because
a final report was twice measured not to be proof the member actually
stopped (a ruling relayed after dispatch produced a new commit
mid-audit). Everything it verifies by running, it runs in a tree nobody
else owns — an add-detach, mutate, remove cycle in its own scratch
worktree at its own dispatch pin — never the PR's own worktree, because
two members writing the same tree at once was measured to silently
destroy uncommitted work. A deliberately cheap tier (haiku) is acceptable
here for the same reason it is on the [Merge bot](merge-bot.md): the
merge gate downstream still catches whatever the finisher gets wrong.
