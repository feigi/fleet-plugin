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
- **Every member acts through the maintainer's `gh` credentials, so no write is
  attributable.** Any invariant about *who* did something is unenforceable after
  the fact: when a label moves unexpectedly, ask members directly, rule out
  automation with `grep -rn '<label>' .github/workflows/`, and do not re-add it.
- Phase 1 is serial. Everything else may run concurrently.
