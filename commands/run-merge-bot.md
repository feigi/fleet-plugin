---
description: merge every approved open PR in numeric order — rebase, wait green, merge
---

Set the goal, then work it until no open PR is left:

`/goal Merge all agent-brain PRs in numeric order if approved. Rebase -> Wait for checks green -> check for approval -> merge if approved`

For each open PR, lowest number first:

1. Rebase its branch onto `origin/main`; push with `--force-with-lease` if it moved.
2. Watch the checks until they settle. Fix failures and repeat from step 1. A missing release label (`patch`/`minor`/`major`) fails `validate-release-label` — add the one matching the change.
3. Green → check approval: `gh pr review`s must include an `APPROVED` and no pending `CHANGES_REQUESTED`. Not approved → skip it, say so, move to the next PR.
4. Approved → `gh pr merge <pr> --merge` (no-ff), then re-fetch and start the next PR on the new `main`.

Report merged / skipped-unapproved / blocked at the end.
