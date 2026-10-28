# Invariants: the full statements

Label names in this file are roles; the Label map gives the string to type; a member never derives the map.

The invariants SKILL.md states one line each, as they read before they were tightened.

- In-flight tickets at most the bound (default 5), ≤ 1 merge bot. The bound
  counts tickets, not live agents — members fan out and their children consume
  slots you never dispatched.
- A grandchild surfaces as its own task-notification. An unrecognized task-id is
  not a member reporting done.
- A reviewer never reviews a PR it implemented.
- The merge bot only touches PRs whose implementer reported done. Rebasing a
  worktree someone is working in destroys uncommitted work.
- `ready-to-merge` is added by a reviewer only — never an implementer, never you.
  **The run's own artifact PR is exempt, and it is exempt because this invariant
  does not reach it:** what the line forbids is a fleet member signing off its own
  ticket work, which presupposes an issue, an implementer, a `review-pr` run and a
  finisher, and the metrics PR you author has none of them. Label and
  merge that one yourself instead of re-deriving a blocker from this line and
  stranding the rows behind it. The exemption belongs to the run that authors the
  PR and does not outlive it: one still open when the run ends is a PR a prior run
  left open, which phase 0 folds into the next run's review queue as ticket work —
  and a PR is not exempt from being wrong, only from waiting on a reviewer
  no phase of this run will ever dispatch against it.
- **Every member acts through the maintainer's `gh` credentials, so no write is
  attributable.** Any invariant about *who* did something is unenforceable after
  the fact: when a label moves unexpectedly, ask members directly, rule out
  automation with `grep -rn '<label>' .github/workflows/`, and do not re-add it.
- Phase 1 is serial. Everything else may run concurrently.
