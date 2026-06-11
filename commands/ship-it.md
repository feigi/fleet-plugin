---
description: Plan + apply recommended actions, push, watch checks, merge if green
argument-hint: "[optional: PR number or extra context]"
allowed-tools: Bash(git:*), Bash(gh:*)
---

# /ship-it

Drive the current change from recommendations to a merged PR. Extra context: $ARGUMENTS

Work the steps in order. Stop and report if any step fails — do not skip ahead.

## 1. Plan + apply recommended actions

- Gather the recommended actions: code-review findings, failing tests, lint/typecheck output, or outstanding TODOs in the current diff. If $ARGUMENTS names a PR, pull its review comments and failing checks too.
- Write a short plan listing each action you intend to apply.
- Apply them. After editing, run the project's local checks (format, lint, typecheck, tests) and confirm they pass before moving on.

## 2. Push

- Commit the applied changes with a clear message.
- Push to the branch's remote. **Never force-push** (not even `--force-with-lease`) without explicit authorization — if the branch diverged, stop and ask.
- If no PR exists for the branch yet, open one with `gh pr create`.

## 3. Watch checks

- Watch CI to completion: `gh pr checks --watch` (or `gh run watch` on the latest run).
- If checks fail: read the logs, fix the cause, and loop back to step 1. Do not merge red.

## 4. Merge if green

- Once **all** required checks pass, merge: `gh pr merge --squash` (use the repo's standard merge method).
- If the merge is blocked because the branch is behind the base under a strict ruleset, update/rebase the branch onto the base, re-push, and re-watch checks before merging.
- Report the merged PR URL when done.
