---
name: next-ticket
description: Use when the user wants to pick up new work — "what's next", "next ticket", "start a new issue", "what should I work on", or asks to grab/start an issue by intent rather than number.
---

# Next Ticket

Suggest ready tickets, let the maintainer pick, mark in-progress, implement at the right depth for the ticket's complexity, and end with a PR rebased on `origin/main`.

**Never grab a ticket unilaterally.** Labels and git state do not record every claim — some claims live only in the maintainer's head or another agent session.

## 1. Candidates

Never fetch raw `body` for the whole list — it is ~97% of the payload. Exclude labels server-side, and reduce each body to its dependency references:

```bash
gh issue list --state open --limit 100 \
  --search '-label:in-progress -label:onhold -label:wontfix -label:needs-triage -label:needs-info' \
  --json number,title,labels,body \
  --jq '[.[]|{n:.number,t:.title,l:[.labels[].name],
             d:[(.body//""|scan("(?i)(?:depends on|blocked by|requires|after)\\s+#\\d+"))]}]'
```

Add `--label ready-for-agent` first; drop it and re-run only if that returns nothing (`ready-for-human` / untriaged fallback).

## 2. Dependencies

Use the `d` array from step 1. Blocker still open → drop the ticket (or surface the blocker instead).
Note reverse edges: a ticket that unblocks others ranks higher.

Read a full body only for the 3–5 that survive: `gh issue view <N> --json body`.

## 3. In-flight check (all three, per candidate)

```bash
gh pr list --state all --search "<N>"
git ls-remote --heads origin | grep -E "[/-]<N>[-/]"
git worktree list; git branch -vv
```

Any hit → ticket is taken. A "shipped" memory is not proof; an open PR means unmerged.

## 4. Suggest — then stop

Present 3–5 survivors, best first. One line each:

`#N — <title> — <why now: unblocks #X, small, adjacent to current branch>`

Then ask which one. **Wait for the answer.** If the maintainer says a ticket is taken, drop it and re-suggest.

## 5. Claim it

```bash
gh label create in-progress --color FBCA04 --force   # first time only
gh issue edit <N> --add-label in-progress
```

Match the repo's existing branch/worktree convention (read `git worktree list` / `git branch -r` to infer it — commonly `feat|fix|refactor/<N>-slug` and `.worktrees/<N>-slug`), branch off a fresh `origin/main`, install deps, run the test baseline.

Remove `in-progress` if the work is abandoned before a PR opens.

## 6. Size the ticket, then pick a path

Judge the ticket as written, not as you hope it is. When torn between two rows, take the heavier one.

| Signal | Path |
|---|---|
| Body states exactly what to change, one or two files, no design choice left open | `superpowers:test-driven-development` |
| Any ambiguity in *what* to build, more than ~3 files, new API/schema/UX, or several viable approaches | `superpowers:brainstorming` → `superpowers:writing-plans` → `superpowers:subagent-driven-development` |

Bug reports: `superpowers:systematic-debugging` first, either way.

## 7. When the superpowers path reports done — open the PR

Come back here. The chosen skill hands off implementation; this step always follows it.

```bash
git fetch origin && git rebase origin/main   # rebase, never merge main in
<test command>                               # re-run after rebasing
git push --force-with-lease -u origin HEAD
gh pr create --base main --body "…

Closes #N"
```

`Closes #N` so the merge closes the issue. If the repo gates on a release label, add exactly one of `patch`/`minor`/`major` now — `validate-release-label` fails without it.

**The session ends here.** Merging happens later, elsewhere: review (`/review-and-fix`) → maintainer adds `ready-to-merge` → `/run-merge-bot` merges in numeric order. Never merge, never add `ready-to-merge` (author's sign-off only), and don't sit watching CI for a merge that won't happen this session.

`in-progress` stays on the issue until that out-of-session merge closes it — harmless, step 1 only lists open issues. Report the PR URL and stop.

## Red flags

- "I'll pull all bodies and filter in my head" → server-side `--search` + `--jq`; bodies only for the shortlist.
- "Label says ready-for-agent, so it's free" → run step 3.
- "Only one candidate, I'll just start" → still ask.
- "Blocker is nearly done" → still blocked.
- "Ticket body is short, so it's simple" → short bodies hide the most design ambiguity. Size by unknowns, not word count.
- "Brainstorming is overkill here" → that thought is step 6's heavier row.
- "Rebase conflicts are messy, I'll merge main in" → rebase; the PR must sit on `origin/main`.
- "Tests passed before the rebase" → re-run after.
- "The implementation skill said done, so I'm done" → no. Step 7 always runs; the PR is the deliverable.
- "I'll wait for CI, then merge it myself" → merge is another session's job. Open PR = done.
- "It's green and obviously fine, I'll add `ready-to-merge`" → that label is the maintainer's sign-off. Never yours.
