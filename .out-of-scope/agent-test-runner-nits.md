# agent-test Runner Nits

The `agent-test` runner that `claim-ticket.sh` emits into each worktree, and the tests
that cover it, attract small tidying proposals. Three have been examined and refused.
The runner's `find` walk, its bare-invocation refusal, and its `.spec.` test all stay as
they are.

## Why this is out of scope

Each was measured before being refused, and each fails for a different reason.

**Adding `-type d` to the `node_modules` prune clause** so the code matches its comment
is a true premise with a vacuous conclusion. A plain *file* named `node_modules` does
match `-name node_modules` and is pruned — but the very next line filters the walk
through the test-file shape:

```sh
testfile_re='\.(test|spec)\.[cm]?[jt]sx?$'
```

A path whose last component is exactly `node_modules` has no dot, so it can never match.
The one delta between the two forms dies at the grep. Zero observable behaviour change.

**Adding a test for the bare form's whole-worktree readability refusal** rests on a
regression that does not exist. The refuter reproduced the A/B and found the *pre-fix*
runner refusing identically on the `.` spelling — the widening the finding attributes to
the bare-form default was already there.

**Deleting the `.spec.` bare-invocation test as dominated by its sibling** loses real
discrimination. Two mutations redden it while leaving the supposed dominator green, both
in `derive-testcmd.sh` — the emit-time path, which carries a hand-synced second copy of
`testfile_re`. A test that is the only thing pinning a hand-synced duplicate is not
dominated by anything.

## Prior requests

- #229 — "add `-type d` to the node_modules prune clause"
- #355 — "cover the bare form's find-readability refusal with a test"
- #356 — "delete the `.spec.` bare-invocation test as dominated by its sibling"
