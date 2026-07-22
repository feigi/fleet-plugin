---
description: review a PR, apply recommended actions, push, watch checks until green
argument-hint: [pr-number]
---

1. Run `/pr-review-toolkit:review-pr $ARGUMENTS` (no argument → PR for the current branch).
2. Plan the recommended actions from the review, then apply them. Split the list explicitly into **apply now** and **defer** — a finding is deferred, never dropped.
3. Commit and push.
4. Watch the PR checks until green; fix any failure and repeat from step 3.
5. File each deferred finding: `gh issue create --label ready-for-agent`, body carrying the finding, its `file:line`, why it was deferred, and `Deferred from PR #<pr> review`. `gh issue list --search` first — comment on a known follow-up instead of duplicating. Post the resulting numbers as one PR comment.
6. Once green **and** deferred findings are filed, sign the PR off for the merge bot: `gh pr edit <pr> --add-label ready-to-merge`. Do not merge.
