---
name: next-ticket
description: Use when user wants pick up new work — "what's next", "next ticket", "start a new issue", "what should I work on", or asks to grab/start an issue by intent rather than number.
---

# Next Ticket

Suggest ready tickets, maintainer picks, mark in-progress, implement at depth ticket needs, end with PR rebased on `origin/main`.

**Never grab ticket unilaterally.** Labels and git state record only some claims; others live in maintainer's head or another agent session.

## 1. Candidates

Never fetch raw `body` for whole list — ~97% of payload. Exclude labels server-side, reduce body to dependency refs:

```bash
gh issue list --state open --limit 100 \
  --search '-label:in-progress -label:onhold -label:wontfix -label:needs-triage -label:needs-info' \
  --json number,title,labels,body \
  --jq '[.[]|{n:.number,t:.title,l:[.labels[].name],
             d:[(.body//""|scan("(?i)(?:depends on|blocked by|requires|after)\\s+#\\d+"))]}]'
```

Add `--label ready-for-agent` first; drop it and re-run only on empty result (`ready-for-human` / untriaged fallback).

## 2. Dependencies

Use `d` array. Blocker open → drop ticket, or surface blocker instead. Ticket unblocking others ranks higher. Cut to 3–5 here; everything below runs per candidate.

## 3. In-flight check (all three, per candidate) — then fetch

```bash
gh pr list --state all --search "<N>"
git ls-remote --heads origin | grep -E "[/-]<N>[-/]"
git worktree list; git branch -vv
```

Any hit → taken. "Shipped" memory not proof; open PR means unmerged.

Title + body + comments, survivors only: `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`. `## Agent Brief` comment outranks body; honor its `Respec` block — can rule out hypotheses body raises. Blocker named only in brief still drops ticket — step 1 `d` array won't have it. Not `--json body` (body only, brief invisible) nor bare `--comments` (comments only, nothing at all when none, exit 0 — silent loss).

Probes take only `<N>`, so they go first — fetching first spends ~6.4 KB on candidates about to be dropped, and a taken `ready-for-agent` ticket is the normal fleet case, not an edge one. They do not go earlier than this: each candidate costs three network round-trips (`scripts/inflight.sh` is the real implementation), so they stay behind step 2's cut and never run over the whole step 1 list.

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

Abandoned before PR opens → remove `in-progress`.

## 6. Size the ticket, then pick a path

Run `sizing-a-ticket`, follow path it returns. Both rows work solo — heavy row means more process, not blocked ticket.

## 7. When the superpowers path reports done — open the PR

Come back here. Implementation skill hands off; this step always follows.

```bash
git fetch origin && git rebase origin/main   # rebase, never merge main in
<test command>                               # re-run after rebasing
git push --force-with-lease -u origin HEAD
gh pr create --base main --body "…

Closes #N"
```

`Closes #N` closes issue on merge. Repo gating on release label → add exactly one of `patch`/`minor`/`major`; `validate-release-label` fails without it.

**Session ends here.** Merge happens later, elsewhere: `/fleet:review-and-fix` → maintainer adds `ready-to-merge` → `/fleet:run-merge-bot` merges in numeric order. Never merge, never add `ready-to-merge` (author's sign-off), never watch CI for merge that won't happen this session.

`in-progress` stays until that out-of-session merge closes issue — harmless, step 1 lists open issues only. Report PR URL, stop.

## Red flags

- "I'll pull all bodies and filter in my head" → server-side `--search` + `--jq`; bodies for shortlist only.
- "Label says ready-for-agent, so it's free" → run step 3.
- "Read the issues first, then check what's taken" → probes first; a dropped candidate's full read is pure waste. Probes still stay behind step 2's cut — they are network calls, not local.
- "Only one candidate, I'll just start" → still ask.
- "Blocker is nearly done" → still blocked.
- "I can size this myself, it's obvious" → run `sizing-a-ticket`; its red flags are ones you'd skip.
- "Rebase conflicts are messy, I'll merge main in" → rebase; PR sits on `origin/main`.
- "Tests passed before the rebase" → re-run after.
- "The implementation skill said done, so I'm done" → step 7 always runs; PR is deliverable.
- "I'll wait for CI, then merge it myself" → merge is another session's job. Open PR = done.
- "It's green and obviously fine, I'll add `ready-to-merge`" → maintainer's sign-off, never yours.