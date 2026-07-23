---
name: next-ticket
description: Use when the user wants to pick up new work — "what's next", "next ticket", "start a new issue", "what should I work on", or asks to grab/start an issue by intent rather than number.
---

# Next Ticket

Suggest ready tickets, maintainer picks, mark in-progress, implement at the depth the ticket needs, end with PR rebased on `origin/main`.

**Never grab a ticket unilaterally.** Labels and git state record only some claims; others live in the maintainer's head or another agent session.

## 1. Candidates

Never fetch raw `body` for the whole list — ~97% of payload. Exclude labels server-side, reduce body to dependency refs:

```bash
gh issue list --state open --limit 100 \
  --search '-label:in-progress -label:onhold -label:wontfix -label:needs-triage -label:needs-info' \
  --json number,title,labels,body \
  --jq '[.[]|{n:.number,t:.title,l:[.labels[].name],
             d:[(.body//""|scan("(?i)(?:depends on|blocked by|requires|after)\\s+#\\d+"))]}]'
```

Add `--label ready-for-agent` first; drop it and re-run only on empty result (`ready-for-human` / untriaged fallback).

## 2. Dependencies

Use the `d` array. Blocker open → drop ticket, or surface blocker instead. Ticket unblocking others ranks higher.

Full body only for the 3–5 survivors: `gh issue view <N> --json body`.

## 3. In-flight check (all three, per candidate)

```bash
gh pr list --state all --search "<N>"
git ls-remote --heads origin | grep -E "[/-]<N>[-/]"
git worktree list; git branch -vv
```

Any hit → taken. "Shipped" memory is not proof; open PR means unmerged.

## 4. Suggest — then stop

3–5 survivors, best first, one line each:

`#N — <title> — <why now: unblocks #X, small, adjacent to current branch>`

Ask which. **Wait for answer.** Maintainer says taken → drop, re-suggest.

## 5. Claim it

```bash
gh label create in-progress --color FBCA04 --force   # first time only
gh issue edit <N> --add-label in-progress
```

Infer branch/worktree convention from `git worktree list` / `git branch -r` — commonly `feat|fix|refactor/<N>-slug` and `.worktrees/<N>-slug`. Branch off fresh `origin/main`, install deps, run test baseline.

Abandoned before a PR opens → remove `in-progress`.

## 6. Size the ticket, then pick a path

Run `sizing-a-ticket`, follow the path it returns. Both rows work solo — heavy row means more process, not a blocked ticket.

## 7. When the superpowers path reports done — open the PR

Come back here. Implementation skill hands off; this step always follows.

```bash
git fetch origin && git rebase origin/main   # rebase, never merge main in
<test command>                               # re-run after rebasing
git push --force-with-lease -u origin HEAD
gh pr create --base main --body "…

Closes #N"
```

`Closes #N` closes the issue on merge. Repo gating on a release label → add exactly one of `patch`/`minor`/`major`; `validate-release-label` fails without it.

**Session ends here.** Merge happens later, elsewhere: `/fleet:review-and-fix` → maintainer adds `ready-to-merge` → `/fleet:run-merge-bot` merges in numeric order. Never merge, never add `ready-to-merge` (author's sign-off), never watch CI for a merge that won't happen this session.

`in-progress` stays until that out-of-session merge closes the issue — harmless, step 1 lists open issues only. Report PR URL, stop.

## Red flags

- "I'll pull all bodies and filter in my head" → server-side `--search` + `--jq`; bodies for shortlist only.
- "Label says ready-for-agent, so it's free" → run step 3.
- "Only one candidate, I'll just start" → still ask.
- "Blocker is nearly done" → still blocked.
- "I can size this myself, it's obvious" → run `sizing-a-ticket`; its red flags are the ones you'd skip.
- "Rebase conflicts are messy, I'll merge main in" → rebase; PR sits on `origin/main`.
- "Tests passed before the rebase" → re-run after.
- "The implementation skill said done, so I'm done" → step 7 always runs; PR is the deliverable.
- "I'll wait for CI, then merge it myself" → merge is another session's job. Open PR = done.
- "It's green and obviously fine, I'll add `ready-to-merge`" → maintainer's sign-off, never yours.
