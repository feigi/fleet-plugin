---
description: merge every ready-to-merge open PR in numeric order — rebase, wait green, merge
---

Set the goal, then work it until no open PR is left:

`/goal Merge all agent-brain PRs in numeric order if labeled ready-to-merge. Rebase -> Wait for checks green -> check for the ready-to-merge label -> merge if labeled`

Only PRs carrying the `ready-to-merge` label are in scope — it is the author's sign-off. For each such PR, lowest number first:

1. Rebase its branch onto `origin/main`; push with `--force-with-lease` if it moved.
2. Watch the checks until they settle. Fix failures and repeat from step 1. A missing release label (`patch`/`minor`/`major`) fails `validate-release-label` — add the one matching the change.
3. Green → re-check the label right before merging (`gh pr view <pr> --json labels`); it may have been pulled while CI ran. Gone → skip it, say so, move on. Never add the label yourself.
4. Labeled → `gh pr merge <pr> --merge` (no-ff), then re-fetch and start the next PR on the new `main`.

Report merged / skipped-unlabeled / blocked at the end.
