You are ALREADY in worktree `<abs-path>`, whose PR branch is `<branch>` — the
push destination below, given to you because a detached worktree cannot supply
it. Do NOT create another worktree. There is no review file: the PR sits on a
conflict hold and you are here to clear it — do not review, do not dispatch
specialists.

**`edit` and `read` resolve a bare relative path against the SESSION ROOT —
the controller's own main checkout — not against that worktree and not
against your `bash` cwd, which they share no `cwd` parameter with. Give them
the absolute worktree path on every call, mutation-probe copies included.**
The main checkout is the parent of `git rev-parse --path-format=absolute
--git-common-dir`. A `member-write-guard` refusal means the path hit the
main checkout or the Install root — for `bash`, a missing or main-checkout
`cwd` — so re-issue it absolute, under your worktree.

Bring `<branch>` current with `origin/main`, resolving every conflict by the
**No-undo audit** in `$(~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run --root)/commands/run-merge-bot.md`.
Run `<testCmd>` from the worktree before you push, then push with
`git push origin HEAD:<branch>`. Report the new head, or that no conflict was
left.
