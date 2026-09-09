---
name: next-ticket
description: Use when user wants pick up new work — "what's next", "next ticket", "start a new issue", "what should I work on", or asks to grab/start an issue by intent rather than number.
---

# Next Ticket

Suggest ready tickets, maintainer picks, mark in-progress, implement at depth ticket needs, end with PR rebased on `origin/main`.

**Never grab ticket unilaterally.** Labels and git state record only some claims; others live in maintainer's head or another agent session.

## 1. Candidates

```bash
~/dev/fleet-plugin/scripts/candidates.mjs --require-label ready-for-agent --allow-fallback
```

Script owns the query: label exclusions server-side, raw `body` never fetched for
whole list (~97% of payload) — reduced to dependency refs, to-spec specs dropped
by shape and named on stderr, survivors oldest first.

`--allow-fallback` re-runs unfiltered (`ready-for-human` / untriaged) when
`ready-for-agent` comes back empty **after specs are dropped** — a queue of
nothing but to-spec specs counts as empty. Solo only — flag exists for this
caller. Fleet never passes it: empty means no work, and an unattended fleet has
no channel to the human `ready-for-human` needs.

Exit 1 = query fine, queue empty. Exit 3 = query fine, rows came back and the
to-spec filter took every one — specs are to-tickets' input, so run to-tickets
rather than reading it as no work. Exit 2 = query broke. Different facts.

Exit 3 judges the LAST pass alone, so with `--allow-fallback` it is the
unfiltered pass's verdict: a labeled pass the filter emptied that falls back to a
genuinely empty one is exit 1, which is the fallback trigger's "counts as empty"
read off the exit code rather than a second rule.

## 2. Dependencies

Use `d` array. Blocker open → drop ticket, or surface blocker instead. Cut to oldest 3–5 here — step 3 runs per candidate. Count is next-ticket's own; fleet Phase 0 sets its own.

Cut runs on step 1 data alone — number, title, labels, `d` — never the Agent Brief; a candidate the Brief would have promoted into survivors is dropped here, before that Brief is ever fetched (#22).

## 3. In-flight check (all three, per candidate) — then fetch

```bash
~/dev/fleet-plugin/scripts/inflight.sh <N>   # 0 free, 1 taken, 2 unanswerable
```

Runs all three — a PR about the ticket, a remote branch, a local worktree or branch. Exit 1 → taken. "Shipped" memory not proof; open PR means unmerged. Exit 2 is not free: the question went unanswered (`gh` failed, no such issue, not a repo), so treat it as taken until you know.

Title + body + comments, survivors only: `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`. `## Agent Brief` comment outranks body. Blocker named only in brief still drops ticket — step 1 `d` array won't have it. Not `--json body` (body only, brief invisible) nor bare `--comments` (comments only, nothing at all when none, exit 0 — silent loss).

Probes take only `<N>`, so they go first — fetching first spends ~6.4 KB (measured once, on #7) on a candidate about to be dropped. Step 1 already excludes `in-progress`, so step 3 catches the claim that never reached the label rather than the common case; the reorder is cheaper either way. They do not go earlier than this: the script makes three network round-trips (`gh issue view`, `gh pr list`, `git ls-remote`; the local probe is free) — so it stays behind step 2's cut and never runs over the whole step 1 list.

## 4. Suggest — then stop

3–5 survivors, **oldest first**, one line each:

`#N — <title> — <why now: adjacent to current branch, or nothing>`

FIFO. Never rank by size — that axis is gone. Never by "unblocks #X" either:
step 2 already dropped anything with an open blocker named in the body — heading,
bold-label, or inline form (#58) — so everything here is free to start unless the
blocker lives only in a native sub-issue/dependency link, which the scan does not
read, or its phrase and its `#N` sit on different lines — both passes are
line-local. "Adjacent to current branch" survives because solo session has one
worktree; means nothing to the fleet, whose members each get their own.

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
gh pr edit --add-label <patch|minor|major>   # own command, own exit status
```

`--force-with-lease` matters only on a re-push: step 7 rebases immediately before pushing, so re-entering step 7 after an earlier push needs the force to land the rebased commits; a denial on a branch that has never been pushed is safe to route around with a plain `git push -u origin HEAD` instead.

`Closes #N` closes issue on merge. Repo gating on release label → exactly one of `patch`/`minor`/`major`; `validate-release-label` fails without it.

**Never fold `--label` into the create.** A `gh pr create` that outruns the caller's tool timeout is backgrounded with the PR already open and its flags unapplied, and a timeout carries no exit status for anything to react to — so the label goes missing and every later gate reads the PR as correctly opened (#375). Written as its own command it has its own exit status and fails loudly; `gh pr edit` with no PR argument resolves the current branch's PR, so it lands even when the create's own output was lost to the timeout. Failed → run it again before reporting the PR.

**Session ends here.** Merge happens later, elsewhere: `/fleet-ctl:review-and-fix` → maintainer adds `ready-to-merge` → `/fleet-ctl:run-merge-bot` merges in numeric order. Never merge, never add `ready-to-merge` (author's sign-off), never watch CI for merge that won't happen this session.

`in-progress` stays until that out-of-session merge closes issue — harmless, step 1 lists open issues only. Report PR URL, stop.

## Red flags

- "I'll pull all bodies and filter in my head" → `--search` narrows server-side, `--jq` reduces inside `gh`; bodies for shortlist only. `candidates.mjs` already does it.
- "I'll inline the `gh` query instead of calling `candidates.mjs`" → don't. A hand-copied duplicate drifts: the copy that lived here missed the to-spec drop and the FIFO sort for a full release, so the solo path shortlisted specs newest-first while the fleet path did neither.
- "Label says ready-for-agent, so it's free" → run step 3.
- "I'll run the three probes inline instead of the script" → don't. Bare `gh pr list --search "<N>"` is a full-text match, so nearly every ticket reads as taken and free work gets skipped silently and permanently; a branch regex demanding a delimiter on both sides misses `fix/<N>` and `<N>-slug`; grepping a worktree's full path false-hits when a parent directory carries the digits. `inflight.sh` handles all three and shows its measurements.
- "Read the issues first, then check what's taken" → probes first; a dropped candidate's full read is pure waste. Probes still stay behind step 2's cut — two of the three hit the network (three round-trips).
- "Only one candidate, I'll just start" → still ask.
- "Blocker is nearly done" → still blocked.
- "I can size this myself, it's obvious" → run `sizing-a-ticket`; its red flags are ones you'd skip.
- "Rebase conflicts are messy, I'll merge main in" → rebase; PR sits on `origin/main`.
- "Tests passed before the rebase" → re-run after.
- "The implementation skill said done, so I'm done" → step 7 always runs; PR is deliverable.
- "I'll wait for CI, then merge it myself" → merge is another session's job. Open PR = done.
- "It's green and obviously fine, I'll add `ready-to-merge`" → maintainer's sign-off, never yours.