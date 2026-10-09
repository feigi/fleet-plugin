# 0023 — The main-gain check is a merge-gate row, acknowledged in the PR body

**Status:** Accepted. Ruled on #2333 in a grilling session; filed as spec #2743.
Amends ADR 0012 (Decision 3). Amended by #2904: R also misses a branch
rewritten into fresh commits (`git reset --soft` + commit, or an
author-resetting squash); see the "R misses two windows" paragraph of the
`plugin/scripts/main-gain.mjs` header.

## Context

The merge bot can merge a PR whose head deletes lines `main` gained after the
PR's work began, and nothing in its procedure notices. In the incident behind
#2333 a branch commit already carried the deletion of tests `main` had merged
in the meantime, most likely written there by an earlier rewrite of the
branch, and every later rebase replayed it with zero conflicts.

- The **no-undo audit** previews conflicts before a rebase and lists the work
  at risk only for files that conflict. A deletion that replays cleanly creates
  no conflict, and its at-risk range runs from the current merge-base, so a
  branch rebased earlier reports nothing.
- The fallback's `origin/main...HEAD` hunk-by-hunk read is a prose step for a
  human or an agent. It is easy to miss in a large diff, and merge-bot agents
  have been seen skipping prose-only steps.
- The suite catches the loss only when some test depends on the deleted
  content.
- `rebase-check` proves currency, not content.
- The server-side `gh pr update-branch --rebase` path, the primary one, replays
  the same deletion as cleanly as the local fallback.

## Decision

1. **A main gain is a line on `main` whose landing on `main` happened after
   the PR's reference point R.** A hit is a main gain the PR's merge would
   remove.
2. **R is the earliest author date among the PR's own commits
   (`origin/main..<head>`).** Rebases and amends keep author dates, so R
   survives rewritten history — a merge-base taken after a rebase does not —
   and it needs no `gh` call. The window it misses is the time between the
   fork and the PR's first commit. The PR's `createdAt` was rejected because
   it is never earlier than R; a fork point recovered from force-push events
   was rejected because it exists only while the pre-rewrite commit is still on
   GitHub.
3. **A line landed when `git blame --first-parent` on `origin/main` says so.**
   `main` is merge-only, so the first-parent commit that brought the line in is
   the landing commit, and its committer date is the landing time.
4. **Removed lines come from the merge the head would actually produce:**
   `git merge-tree --write-tree origin/main <head>`, diffed against
   `origin/main` with rename detection on. That is right when the head is
   behind `main`, where a three-dot diff is wrong. A line replaced by other
   text counts; a line whose exact text is added back in the same file is a
   move and does not; a deleted file's lines count; binary files are listed as
   unchecked rather than blocking; a merge that does not resolve cleanly is
   "cannot answer", never a guess at a resolution.
5. **The check is a row in the merge gate, not a fallback-only or audit-hosted
   step.** It then covers every merge path — server-side rebase, local
   fallback, no rebase — and an agent cannot skip it the way it can skip
   prose. `merge-gate.mjs` reads the PR body alongside the fields it already
   reads and runs `main-gain.mjs` against the PR head in the main checkout: a
   hit is `main-gain-removed:<first path>` (exit 1, right after
   `head-moved-after-label`), no answer is `main-gain-unanswerable` (exit 2).
   The local fallback's "verified" verdict also needs a clean main-gain result
   on the local rebased head. A hit leaves the label and the ledger alone:
   repeated skip-and-report is the signal until the PR is fixed or
   acknowledged, and no agent restores lines whose removal may be deliberate.
6. **A deliberate removal is acknowledged in the PR body, as a scoped second
   sign-off next to `ready-to-merge`:** one line per file and landing source,
   `main-gain-removal: <path> <key> - <why>`, the key being `#<n>` for a
   GitHub merge of PR n and otherwise the landing commit's 12-character SHA.
   It is read whenever the gate runs, so editing the body resolves a hit
   without rewriting history. A marker with an empty reason does not count.
   Acknowledged removals pass and are always listed, in the gate payload and
   in the merge bot's report.
7. **The pre-rebase head gives the same verdict as the rebased one.** On the
   server-side path the PR object can lag at the pre-rebase SHA for a while;
   `git merge-tree` against `main` lands the same content from either head, so
   that lag cannot flip the answer.

## Consequences

- The gate does git work: one `merge-tree` plus a first-parent blame per file
  with removals. Cost scales with the files whose lines the PR removes, not
  with the size of the repository.
- The check reads the main checkout after a plain `git fetch origin`, which
  the merge bot already runs before each gate run. A head object the checkout
  does not hold is "cannot answer", never clean.
- The no-undo audit is unchanged. Its pre-rebase conflict preview keeps its
  role; the main-gain check is its post-rebase counterpart.
- Left out: a fork-point three-way pass, a line-count heuristic, changing
  which rebase path the merge bot prefers, checks at the upstream rebase sites,
  ledger hold tokens or automatic restoration, and honouring an
  acknowledgement only if it predates the label.
